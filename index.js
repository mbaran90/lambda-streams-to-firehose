/*
AWS Streams to Firehose

Copyright 2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
 */
var debug = false;

var pjson = require('./package.json');
var region = process.env['AWS_REGION'];

if (!region || region === null || region === "") {
	region = "us-east-1";
	console.log("Warning: Setting default region " + region);
}

if (debug) {
	console.log("AWS Streams to Firehose Forwarder v" + pjson.version + " in " + region);
}

var aws = require('aws-sdk');
aws.config.update({
	region : region
});

var firehose = new aws.Firehose({
	apiVersion : '2015-08-04',
	region : region
});
var kinesis = new aws.Kinesis({
	apiVersion : '2013-12-02',
	region : region
});
var async = require('async');

var OK = 'OK';
var ERROR = 'ERROR';
var FORWARD_TO_FIREHOSE_STREAM = "ForwardToFirehoseStream";
var DDB_SERVICE_NAME = "aws:dynamodb";
var KINESIS_SERVICE_NAME = "aws:kinesis";
var FIREHOSE_MAX_BATCH_COUNT = 500;
// firehose max PutRecordBatch size 4MB
var FIREHOSE_MAX_BATCH_BYTES = 4 * 1024 * 1024;

/* 
 * If the source Kinesis Stream's tags or DynamoDB Stream Name don't resolve to
 * an existing Firehose, allow usage of a default delivery stream, or fail with
 * an error.
 */
var USE_DEFAULT_DELIVERY_STREAMS = true;
/*
 * Delivery stream mappings can be specified here to overwrite values provided
 * by Kinesis Stream tags or DynamoDB stream name. (Helpful for debugging)
 * Format:
 *   DDBStreamName: deliveryStreamName
 * Or:
 *   FORWARD_TO_FIREHOSE_STREAM tag value: deliveryStreamName
 */
var deliveryStreamMapping = {
	DEFAULT: 'LambdaStreamsDefaultDeliveryStream'
};

/**
 * Example transformer that adds a newline to each event
 * 
 * Args:
 * 
 * data - base64 encoded Buffer containing kinesis data
 * 
 * callback(err,data) - callback to be called once transformation is completed.
 * data can be undefined if a filter is implemented
 */
exports.addNewlineTransformer = function(data, callback) {
	// emitting a new buffer as ascii text with newline
	callback(null, new Buffer(data.toString('ascii') + "\n"));
};

/**
 * Example transformer that converts a regular expression to delimited text
 */
exports.regexToDelimiter = function(regex, delimiter, data, callback) {
	var tokens = data.toString('ascii').match(regex);

	if (tokens) {
		callback(null, new Buffer(tokens.slice(1).join(delimiter) + "\n"));
	} else {
		callback("Configured Regular Expression does not match any tokens", null);
	}
};
var transformer = exports.addNewlineTransformer.bind(undefined);
//
// example regex transformer that matches all text after 'my regex' and turns it
// into pipe delimited text
// var transformer = exports.regexToDelimiter.bind(undefined, /(myregex) (.*)/,
// "|");

/**
 * Function which returns the byte length of a string
 */
exports.byteCount = function(s) {
	return encodeURI(s).split(/%..|./).length - 1;
};

/**
 * Convenience function which generates the batch set with low and high offsets
 * for pushing data to Firehose in blocks of FIREHOSE_MAX_BATCH_COUNT and
 * staying within the FIREHOSE_MAX_BATCH_BYTES max payload size. Batch ranges
 * are calculated to be compatible with the array.slice() function which uses a
 * non-inclusive upper bound
 */
exports.getBatchRanges = function(records) {
	var batches = [];
	var currentLowOffset = 0;
	var batchCurrentBytes = 0;
	var batchCurrentCount = 0;
	var recordSize;

	for (var i = 0; i < records.length; i++) {
		// need to calculate the total record size for the call to Firehose on
		// the basis of of non-base64 encoded values
		recordSize = exports.byteCount(records[i].Data.toString('ascii'));

		// batch always has 1 entry, so add it first
		batchCurrentBytes += recordSize;
		batchCurrentCount += 1;

		// generate a new batch marker every 4MB or 500 records, whichever comes
		// first
		if (batchCurrentCount === FIREHOSE_MAX_BATCH_COUNT || batchCurrentBytes + recordSize > FIREHOSE_MAX_BATCH_BYTES || i === records.length - 1) {
			batches.push({
				lowOffset : currentLowOffset,
				// annoying special case handling for record sets of size 1
				highOffset : i + 1,
				sizeBytes : batchCurrentBytes
			});
			// reset accumulators
			currentLowOffset = i + 1;
			batchCurrentBytes = 0;
			batchCurrentCount = 0;
		}
	}

	return batches;
};

/**
 * Function to create a condensed version of a dynamodb change record
 */
exports.createDynamoDataItem = function(record) {
	var output = {};
	output.Keys = record.dynamodb.Keys;

	if (record.dynamodb.NewImage)
		output.NewImage = record.dynamodb.NewImage;
	if (record.dynamodb.OldImage)
		output.OldImage = record.dynamodb.OldImage;

	output.SequenceNumber = record.dynamodb.SequenceNumber;
	output.SizeBytes = record.dynamodb.SizeBytes;
	output.eventName = record.eventName;

	// return a string version of the data
	return output;
};

exports.getStreamName = function(arn) {
	var eventSourceARNTokens = arn.split(":");
	return eventSourceARNTokens[5].split("/")[1];
};

exports.handler = function(event, context) {
	/** Runtime Functions */
	var finish = function(event, status, message) {
		console.log("Processing Complete");

		// log the event if we've failed
		if (status !== OK) {
			if (message) {
				console.log(message);
			}

			// ensure that Lambda doesn't checkpoint to kinesis on error
			context.done(status, JSON.stringify(message));
		} else {
			context.done(null, message);
		}
	};

	/**
	 * function which handles the output of the defined transformation on each
	 * record.
	 */
	exports.processTransformedRecords = function(transformed, streamName, deliveryStreamName) {
		// get the set of batch offsets based on the transformed record sizes
		var batches = exports.getBatchRanges(transformed);

		if (debug) {
			console.log(JSON.stringify(batches));
		}

		// push to Firehose using PutRecords API at max record count or size.
		// This uses the async reduce method so that records from Kinesis will
		// appear in the Firehose PutRecords request in the same order as they
		// were received by this function
		async.reduce(batches, 0, function(successCount, item, reduceCallback) {
			if (debug) {
				console.log("Forwarding records " + item.lowOffset + ":" + item.highOffset + " - " + item.sizeBytes + " Bytes");
			}

			// grab subset of the records assigned for this batch and push to
			// firehose
			var processRecords = transformed.slice(item.lowOffset, item.highOffset);

			exports.writeToFirehose(processRecords, streamName, deliveryStreamName, function(err) {
				if (err) {
					reduceCallback(err, successCount);
				} else {
					reduceCallback(null, successCount + 1);
				}
			});
		}, function(err, result) {
			if (err) {
				console.log("Forwarding failure after " + result + " successful batches");
				finish(err, ERROR);
			} else {
				console.log("Event forwarding complete. Forwarded " + result + " batches comprising " + event.Records.length + " records to Firehose " + deliveryStreamName);
				finish(null, OK);
			}
		});
	};

	/**
	 * function which forwards a batch of kinesis records to a firehose delivery
	 * stream
	 */
	exports.writeToFirehose = function(firehoseBatch, streamName, deliveryStreamName, callback) {
		// write the batch to firehose with putRecordBatch
		var putRecordBatchParams = {
			DeliveryStreamName : deliveryStreamName,
			Records : firehoseBatch
		};
		firehose.putRecordBatch(putRecordBatchParams, function(err, data) {
			if (err) {
				console.log(JSON.stringify(err));
				callback(err);
			} else {
				if (debug) {
					console.log("Successfully wrote " + firehoseBatch.length + " records to Firehose " + deliveryStreamName);
				}
				callback();
			}
		});
	};

	/**
	 * Function to process a Kinesis Event from AWS Lambda, and generate
	 * requests to forward to Firehose
	 */
	exports.processEvent = function(event, serviceName, streamName) {
		// look up the delivery stream name of the mapping cache
		var deliveryStreamName = deliveryStreamMapping[streamName];

		if (debug) {
			console.log("Forwarding " + event.Records.length + " " + serviceName + " records to Delivery Stream " + deliveryStreamName);
		}

		// run the user defined transformer for each record to be processed
		async.map(event.Records, function(item, callback) {
			// resolve the record data based on the service
			var data;

			if (serviceName === KINESIS_SERVICE_NAME) {
				data = new Buffer(item.kinesis.data, 'base64');
			} else {
				data = new Buffer(JSON.stringify(exports.createDynamoDataItem(item)));
			}

			transformer(data, function(err, transformed) {
				if (err) {
					console.log(JSON.stringify(err));
					callback(err, null);
				} else {
					if (transformed) {
						if (!(transformed instanceof Buffer)) {
							callback("Output of Transformer must be an instance of Buffer", null);
						} else {
							// call the map callback with the transformed Buffer
							// decorated for use as a Firehose batch entry
							callback(null, {
								Data : transformed
							});
						}
					}
				}
			});
		}, function(err, transformed) {
			if (err) {
				finish(err, ERROR);
			} else {
				exports.processTransformedRecords(transformed, streamName, deliveryStreamName);
			}
		});
	};

	/**
	 * Function which resolves the destination delivery stream from the
	 * specified Kinesis Stream Name, using Tags
	 */
	exports.buildDeliveryMap = function(streamName, serviceName, event, callback) {
		if (deliveryStreamMapping[streamName]) {
			// A delivery stream has already been specified in configuration
			// This could be indicative of debug usage.
			USE_DEFAULT_DELIVERY_STREAMS = false;
			verifyDeliveryStreamMapping(streamName, event, callback);
		} else if (serviceName === DDB_SERVICE_NAME) {
			// dynamodb streams need the firehose delivery stream to match
			// the table name
			deliveryStreamMapping[streamName] = streamName;
			verifyDeliveryStreamMapping(streamName, event, callback);
		} else {
			// get the delivery stream name from Kinesis tag
			kinesis.listTagsForStream({
				StreamName : streamName
			}, function(err, data) {
				if (err) {
					finish(event, ERROR, err);
				} else {
					// grab the tag value if it's the foreward_to_firehose
					// name
					// item
					data.Tags.map(function(item) {
						if (item.Key === FORWARD_TO_FIREHOSE_STREAM) {
							/* Disable fallback to a default delivery stream as
							 * a FORWARD_TO_FIREHOSE_STREAM has been specifically
							 * set.
							 */
							USE_DEFAULT_DELIVERY_STREAMS = false;
							deliveryStreamMapping[streamName] = item.Value;
						}
					});

					verifyDeliveryStreamMapping(streamName, event, callback);
				}
			});
		}
	};

	exports.verifyDeliveryStreamMapping = function(streamName, event, callback) {
		if (!deliveryStreamMapping[streamName]) {
			if (USE_DEFAULT_DELIVERY_STREAMS) {
				/* No delivery stream has been specified, probably as it's not 
				 * configured in stream tags. Using default delivery stream.
				 * To prevent accidental forwarding of streams to a firehose set
				 * USE_DEFAULT_DELIVERY_STREAMS = false.
				 */
				deliveryStreamMapping[streamName] = deliveryStreamMapping[DEFAULT];
			} else {
				/*
				 * Fail as no delivery stream mapping has been specified and we
				 * have not configured to use a default.
				 * Kinesis Streams should be tagged with
				 * ForwardToFirehoseStream = <DeliveryStreamName>
				 */
				finish(event, ERROR, "Warning: No Kinesis Stream " + streamName + " not tagged for Firehose delivery with Tag name " + FORWARD_TO_FIREHOSE_STREAM);
				return;
			}
		}
		// validate the delivery stream name provided
		var params = {
			DeliveryStreamName : deliveryStreamMapping[streamName]
		};
		firehose.describeDeliveryStream(params, function(err, data) {
			if (err) {
				// do not continue with the cached mapping
				delete deliveryStreamMapping[streamName];

				if (!USE_DEFAULT_DELIVERY_STREAMS || deliveryStreamMapping[streamName] == deliveryStreamMapping[DEFAULT]) {
					finish(event, ERROR, "Delivery Stream " + deliveryStreamMapping[streamName] + " does not exist in region " + region);
				} else {
					deliveryStreamMapping[streamName] = deliveryStreamMapping[DEFAULT];
				}
			} else {
				// call the specified callback - should have
				// already
				// been prepared by the calling function
				callback();
			}
		});
	}

	/** End Runtime Functions */
	if (debug) {
		console.log(JSON.stringify(event));
	}

	// fail the function if the wrong event source type is being sent, or if
	// there is no data, etc
	var noProcessStatus = ERROR;
	var noProcessReason;

	if (!event.Records || event.Records.length === 0) {
		noProcessReason = "Event contains no Data";
		// not fatal - just got an empty event
		noProcessStatus = OK;
	}

	// only configured to support Kinesis and DynamoDB events. Maybe support SNS in future?
	var serviceName;
	if (event.Records[0].eventSource === KINESIS_SERVICE_NAME || event.Records[0].eventSource === DDB_SERVICE_NAME) {
		serviceName = event.Records[0].eventSource;
	} else {
		noProcessReason = "Invalid Event Source " + event.Records[0].eventSource;
	}

	// currently hard coded around the 1.0 kinesis event schema
	if (event.Records[0].kinesis && event.Records[0].kinesis.kinesisSchemaVersion !== "1.0") {
		noProcessReason = "Unsupported Kinesis Event Schema Version " + event.Records[0].kinesis.kinesisSchemaVersion;
	}

	if (noProcessReason) {
		// terminate if there were any non process reasons
		finish(event, noProcessStatus, noProcessReason);
	} else {
		// parse the stream name out of the event
		var streamName = exports.getStreamName(event.Records[0].eventSourceARN);

		if (deliveryStreamMapping.length === 0 || !deliveryStreamMapping[streamName]) {
			// no delivery stream cached so far, so add this stream's tag value
			// to the delivery map, and continue with processEvent
			exports.buildDeliveryMap(streamName, serviceName, event, exports.processEvent.bind(undefined, event, serviceName, streamName));
		} else {
			// delivery stream is cached
			exports.processEvent(event, serviceName, streamName);
		}
	}
};