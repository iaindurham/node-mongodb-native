var shared = require('./shared')
  , utils = require('../utils')
  , Code = require('bson').Code  
  , DbCommand = require('../commands/db_command').DbCommand;

/**
 * Functions that are passed as scope args must
 * be converted to Code instances.
 * @ignore
 */
function processScope (scope) {
  if (!utils.isObject(scope)) {
    return scope;
  }

  var keys = Object.keys(scope);
  var i = keys.length;
  var key;

  while (i--) {
    key = keys[i];
    if ('function' == typeof scope[key]) {
      scope[key] = new Code(String(scope[key]));
    }
  }

  return scope;
}

var mapReduce = function mapReduce (map, reduce, options, callback) {
  if ('function' === typeof options) callback = options, options = {};
  // Out must allways be defined (make sure we don't break weirdly on pre 1.8+ servers)
  if(null == options.out) {
    throw new Error("the out option parameter must be defined, see mongodb docs for possible values");
  }

  if ('function' === typeof map) {
    map = map.toString();
  }

  if ('function' === typeof reduce) {
    reduce = reduce.toString();
  }

  if ('function' === typeof options.finalize) {
    options.finalize = options.finalize.toString();
  }

  var mapCommandHash = {
      mapreduce: this.collectionName
    , map: map
    , reduce: reduce
  };

  // Add any other options passed in
  for (var name in options) {
    if ('scope' == name) {
      mapCommandHash[name] = processScope(options[name]);
    } else {
      mapCommandHash[name] = options[name];
    }
  }

  // Set read preference if we set one
  var readPreference = shared._getReadConcern(this, options);

  // If we have a read preference and inline is not set as output fail hard
  if((readPreference != false && readPreference != 'primary') 
    && options['out'] && (options['out'].inline != 1 && options['out'] != 'inline')) {
      throw new Error("a readPreference can only be provided when performing an inline mapReduce");
  }

  // self
  var self = this;
  var cmd = DbCommand.createDbCommand(this.db, mapCommandHash);

  this.db._executeQueryCommand(cmd, {read:readPreference}, function (err, result) {
    if(err) return callback(err);
    if(!result || !result.documents || result.documents.length == 0)
      return callback(Error("command failed to return results"), null)

    // Check if we have an error
    if(1 != result.documents[0].ok || result.documents[0].err || result.documents[0].errmsg) {
      return callback(utils.toError(result.documents[0]));
    }

    // Create statistics value
    var stats = {};
    if(result.documents[0].timeMillis) stats['processtime'] = result.documents[0].timeMillis;
    if(result.documents[0].counts) stats['counts'] = result.documents[0].counts;
    if(result.documents[0].timing) stats['timing'] = result.documents[0].timing;

    // invoked with inline?
    if(result.documents[0].results) {
      return callback(null, result.documents[0].results, stats);
    }

    // The returned collection
    var collection = null;

    // If we have an object it's a different db
    if(result.documents[0].result != null && typeof result.documents[0].result == 'object') {
      var doc = result.documents[0].result;
      collection = self.db.db(doc.db).collection(doc.collection);
    } else {
      // Create a collection object that wraps the result collection
      collection = self.db.collection(result.documents[0].result)
    }

    // If we wish for no verbosity
    if(options['verbose'] == null || !options['verbose']) {
      return callback(err, collection);
    }

    // Return stats as third set of values
    callback(err, collection, stats);
  });
};

/**
 * Group function helper
 * @ignore
 */
var groupFunction = function () {
  var c = db[ns].find(condition);
  var map = new Map();
  var reduce_function = reduce;

  while (c.hasNext()) {
    var obj = c.next();
    var key = {};

    for (var i = 0, len = keys.length; i < len; ++i) {
      var k = keys[i];
      key[k] = obj[k];
    }

    var aggObj = map.get(key);

    if (aggObj == null) {
      var newObj = Object.extend({}, key);
      aggObj = Object.extend(newObj, initial);
      map.put(key, aggObj);
    }

    reduce_function(obj, aggObj);
  }

  return { "result": map.values() };
}.toString();

var group = function group(keys, condition, initial, reduce, finalize, command, options, callback) {
  var args = Array.prototype.slice.call(arguments, 3);
  callback = args.pop();
  // Fetch all commands
  reduce = args.length ? args.shift() : null;
  finalize = args.length ? args.shift() : null;
  command = args.length ? args.shift() : null;
  options = args.length ? args.shift() || {} : {};

  // Make sure we are backward compatible
  if(!(typeof finalize == 'function')) {
    command = finalize;
    finalize = null;
  }

  if (!Array.isArray(keys) && keys instanceof Object && typeof(keys) !== 'function' && !(keys instanceof Code)) {
    keys = Object.keys(keys);
  }

  if(typeof reduce === 'function') {
    reduce = reduce.toString();
  }

  if(typeof finalize === 'function') {
    finalize = finalize.toString();
  }

  // Set up the command as default
  command = command == null ? true : command;

  // Execute using the command
  if(command) {
    var reduceFunction = reduce instanceof Code
        ? reduce
        : new Code(reduce);

    var selector = {
      group: {
          'ns': this.collectionName
        , '$reduce': reduceFunction
        , 'cond': condition
        , 'initial': initial
        , 'out': "inline"
      }
    };

    // if finalize is defined
    if(finalize != null) selector.group['finalize'] = finalize;
    // Set up group selector
    if ('function' === typeof keys || keys instanceof Code) {
      selector.group.$keyf = keys instanceof Code
        ? keys
        : new Code(keys);
    } else {
      var hash = {};
      keys.forEach(function (key) {
        hash[key] = 1;
      });
      selector.group.key = hash;
    }

    var cmd = DbCommand.createDbSlaveOkCommand(this.db, selector);
    // Set read preference if we set one
    var readPreference = shared._getReadConcern(this, options);
    // Execute the command
    this.db._executeQueryCommand(cmd
      , {read:readPreference}
      , utils.handleSingleCommandResultReturn(null, null, function(err, result) {
        if(err) return callback(err, null);
        callback(null, result.retval);
      }));
  } else {
    // Create execution scope
    var scope = reduce != null && reduce instanceof Code
      ? reduce.scope
      : {};

    scope.ns = this.collectionName;
    scope.keys = keys;
    scope.condition = condition;
    scope.initial = initial;

    // Pass in the function text to execute within mongodb.
    var groupfn = groupFunction.replace(/ reduce;/, reduce.toString() + ';');

    this.db.eval(new Code(groupfn, scope), function (err, results) {
      if (err) return callback(err, null);
      callback(null, results.result || results);
    });
  }
};

var aggregate = function(pipeline, options, callback) {
  // *  - **explain** {Boolean}, return the query plan for the aggregation pipeline instead of the results. 2.3, 2.4
  var args = Array.prototype.slice.call(arguments, 0);
  callback = args.pop();
  var self = this;

  // If we have any of the supported options in the options object
  var opts = args[args.length - 1];
  options = opts.readPreference || opts.explain ? args.pop() : {}

  // Convert operations to an array
  if(!Array.isArray(args[0])) {
    pipeline = [];
    // Push all the operations to the pipeline
    for(var i = 0; i < args.length; i++) pipeline.push(args[i]);
  }

  // Build the command
  var command = { aggregate : this.collectionName, pipeline : pipeline};

  // Ensure we have the right read preference inheritance
  options.readPreference = shared._getReadConcern(this, options);
  // If explain has been specified add it
  if(options.explain) command.explain = options.explain;
  // Execute the command
  this.db.command(command, options, function(err, result) {
    if(err) {
      callback(err);
    } else if(result['err'] || result['errmsg']) {
      callback(utils.toError(result));
    } else if(typeof result == 'object' && result['serverPipeline']) {
      callback(null, result['serverPipeline']);
    } else {
      callback(null, result.result);
    }
  });
}

exports.mapReduce = mapReduce;
exports.group = group;
exports.aggregate = aggregate;