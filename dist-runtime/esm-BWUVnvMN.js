import { n as __esmMin, r as __exportAll } from "./chunk-DORXReHP.js";
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/platform/node/globalThis.js
var _globalThis;
var init_globalThis = __esmMin((() => {
	_globalThis = typeof globalThis === "object" ? globalThis : global;
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/platform/node/index.js
var init_node = __esmMin((() => {
	init_globalThis();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/platform/index.js
var init_platform = __esmMin((() => {
	init_node();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/version.js
var VERSION;
var init_version = __esmMin((() => {
	VERSION = "1.9.0";
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/internal/semver.js
/**
* Create a function to test an API version to see if it is compatible with the provided ownVersion.
*
* The returned function has the following semantics:
* - Exact match is always compatible
* - Major versions must match exactly
*    - 1.x package cannot use global 2.x package
*    - 2.x package cannot use global 1.x package
* - The minor version of the API module requesting access to the global API must be less than or equal to the minor version of this API
*    - 1.3 package may use 1.4 global because the later global contains all functions 1.3 expects
*    - 1.4 package may NOT use 1.3 global because it may try to call functions which don't exist on 1.3
* - If the major version is 0, the minor version is treated as the major and the patch is treated as the minor
* - Patch and build tag differences are not considered at this time
*
* @param ownVersion version which should be checked against
*/
function _makeCompatibilityCheck(ownVersion) {
	var acceptedVersions = new Set([ownVersion]);
	var rejectedVersions = /* @__PURE__ */ new Set();
	var myVersionMatch = ownVersion.match(re);
	if (!myVersionMatch) return function() {
		return false;
	};
	var ownVersionParsed = {
		major: +myVersionMatch[1],
		minor: +myVersionMatch[2],
		patch: +myVersionMatch[3],
		prerelease: myVersionMatch[4]
	};
	if (ownVersionParsed.prerelease != null) return function isExactmatch(globalVersion) {
		return globalVersion === ownVersion;
	};
	function _reject(v) {
		rejectedVersions.add(v);
		return false;
	}
	function _accept(v) {
		acceptedVersions.add(v);
		return true;
	}
	return function isCompatible(globalVersion) {
		if (acceptedVersions.has(globalVersion)) return true;
		if (rejectedVersions.has(globalVersion)) return false;
		var globalVersionMatch = globalVersion.match(re);
		if (!globalVersionMatch) return _reject(globalVersion);
		var globalVersionParsed = {
			major: +globalVersionMatch[1],
			minor: +globalVersionMatch[2],
			patch: +globalVersionMatch[3],
			prerelease: globalVersionMatch[4]
		};
		if (globalVersionParsed.prerelease != null) return _reject(globalVersion);
		if (ownVersionParsed.major !== globalVersionParsed.major) return _reject(globalVersion);
		if (ownVersionParsed.major === 0) {
			if (ownVersionParsed.minor === globalVersionParsed.minor && ownVersionParsed.patch <= globalVersionParsed.patch) return _accept(globalVersion);
			return _reject(globalVersion);
		}
		if (ownVersionParsed.minor <= globalVersionParsed.minor) return _accept(globalVersion);
		return _reject(globalVersion);
	};
}
var re, isCompatible;
var init_semver = __esmMin((() => {
	init_version();
	re = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
	isCompatible = _makeCompatibilityCheck(VERSION);
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/internal/global-utils.js
function registerGlobal(type, instance, diag, allowOverride) {
	var _a;
	if (allowOverride === void 0) allowOverride = false;
	var api = _global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a !== void 0 ? _a : { version: VERSION };
	if (!allowOverride && api[type]) {
		var err = /* @__PURE__ */ new Error("@opentelemetry/api: Attempted duplicate registration of API: " + type);
		diag.error(err.stack || err.message);
		return false;
	}
	if (api.version !== "1.9.0") {
		var err = /* @__PURE__ */ new Error("@opentelemetry/api: Registration of version v" + api.version + " for " + type + " does not match previously registered API v" + VERSION);
		diag.error(err.stack || err.message);
		return false;
	}
	api[type] = instance;
	diag.debug("@opentelemetry/api: Registered a global for " + type + " v" + VERSION + ".");
	return true;
}
function getGlobal(type) {
	var _a, _b;
	var globalVersion = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a === void 0 ? void 0 : _a.version;
	if (!globalVersion || !isCompatible(globalVersion)) return;
	return (_b = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b === void 0 ? void 0 : _b[type];
}
function unregisterGlobal(type, diag) {
	diag.debug("@opentelemetry/api: Unregistering a global for " + type + " v" + VERSION + ".");
	var api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
	if (api) delete api[type];
}
var major, GLOBAL_OPENTELEMETRY_API_KEY, _global;
var init_global_utils = __esmMin((() => {
	init_platform();
	init_version();
	init_semver();
	major = VERSION.split(".")[0];
	GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api." + major);
	_global = _globalThis;
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/ComponentLogger.js
function logProxy(funcName, namespace, args) {
	var logger = getGlobal("diag");
	if (!logger) return;
	args.unshift(namespace);
	return logger[funcName].apply(logger, __spreadArray$3([], __read$4(args), false));
}
var __read$4, __spreadArray$3, DiagComponentLogger;
var init_ComponentLogger = __esmMin((() => {
	init_global_utils();
	__read$4 = function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	__spreadArray$3 = function(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	};
	DiagComponentLogger = function() {
		function DiagComponentLogger(props) {
			this._namespace = props.namespace || "DiagComponentLogger";
		}
		DiagComponentLogger.prototype.debug = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return logProxy("debug", this._namespace, args);
		};
		DiagComponentLogger.prototype.error = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return logProxy("error", this._namespace, args);
		};
		DiagComponentLogger.prototype.info = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return logProxy("info", this._namespace, args);
		};
		DiagComponentLogger.prototype.warn = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return logProxy("warn", this._namespace, args);
		};
		DiagComponentLogger.prototype.verbose = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			return logProxy("verbose", this._namespace, args);
		};
		return DiagComponentLogger;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/types.js
var DiagLogLevel;
var init_types = __esmMin((() => {
	(function(DiagLogLevel) {
		/** Diagnostic Logging level setting to disable all logging (except and forced logs) */
		DiagLogLevel[DiagLogLevel["NONE"] = 0] = "NONE";
		/** Identifies an error scenario */
		DiagLogLevel[DiagLogLevel["ERROR"] = 30] = "ERROR";
		/** Identifies a warning scenario */
		DiagLogLevel[DiagLogLevel["WARN"] = 50] = "WARN";
		/** General informational log message */
		DiagLogLevel[DiagLogLevel["INFO"] = 60] = "INFO";
		/** General debug log message */
		DiagLogLevel[DiagLogLevel["DEBUG"] = 70] = "DEBUG";
		/**
		* Detailed trace level logging should only be used for development, should only be set
		* in a development environment.
		*/
		DiagLogLevel[DiagLogLevel["VERBOSE"] = 80] = "VERBOSE";
		/** Used to set the logging level to include all logging */
		DiagLogLevel[DiagLogLevel["ALL"] = 9999] = "ALL";
	})(DiagLogLevel || (DiagLogLevel = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/internal/logLevelLogger.js
function createLogLevelDiagLogger(maxLevel, logger) {
	if (maxLevel < DiagLogLevel.NONE) maxLevel = DiagLogLevel.NONE;
	else if (maxLevel > DiagLogLevel.ALL) maxLevel = DiagLogLevel.ALL;
	logger = logger || {};
	function _filterFunc(funcName, theLevel) {
		var theFunc = logger[funcName];
		if (typeof theFunc === "function" && maxLevel >= theLevel) return theFunc.bind(logger);
		return function() {};
	}
	return {
		error: _filterFunc("error", DiagLogLevel.ERROR),
		warn: _filterFunc("warn", DiagLogLevel.WARN),
		info: _filterFunc("info", DiagLogLevel.INFO),
		debug: _filterFunc("debug", DiagLogLevel.DEBUG),
		verbose: _filterFunc("verbose", DiagLogLevel.VERBOSE)
	};
}
var init_logLevelLogger = __esmMin((() => {
	init_types();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/diag.js
var __read$3, __spreadArray$2, API_NAME$4, DiagAPI;
var init_diag = __esmMin((() => {
	init_ComponentLogger();
	init_logLevelLogger();
	init_types();
	init_global_utils();
	__read$3 = function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	__spreadArray$2 = function(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	};
	API_NAME$4 = "diag";
	DiagAPI = function() {
		/**
		* Private internal constructor
		* @private
		*/
		function DiagAPI() {
			function _logProxy(funcName) {
				return function() {
					var args = [];
					for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
					var logger = getGlobal("diag");
					if (!logger) return;
					return logger[funcName].apply(logger, __spreadArray$2([], __read$3(args), false));
				};
			}
			var self = this;
			var setLogger = function(logger, optionsOrLogLevel) {
				var _a, _b, _c;
				if (optionsOrLogLevel === void 0) optionsOrLogLevel = { logLevel: DiagLogLevel.INFO };
				if (logger === self) {
					var err = /* @__PURE__ */ new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
					self.error((_a = err.stack) !== null && _a !== void 0 ? _a : err.message);
					return false;
				}
				if (typeof optionsOrLogLevel === "number") optionsOrLogLevel = { logLevel: optionsOrLogLevel };
				var oldLogger = getGlobal("diag");
				var newLogger = createLogLevelDiagLogger((_b = optionsOrLogLevel.logLevel) !== null && _b !== void 0 ? _b : DiagLogLevel.INFO, logger);
				if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
					var stack = (_c = (/* @__PURE__ */ new Error()).stack) !== null && _c !== void 0 ? _c : "<failed to generate stacktrace>";
					oldLogger.warn("Current logger will be overwritten from " + stack);
					newLogger.warn("Current logger will overwrite one already registered from " + stack);
				}
				return registerGlobal("diag", newLogger, self, true);
			};
			self.setLogger = setLogger;
			self.disable = function() {
				unregisterGlobal(API_NAME$4, self);
			};
			self.createComponentLogger = function(options) {
				return new DiagComponentLogger(options);
			};
			self.verbose = _logProxy("verbose");
			self.debug = _logProxy("debug");
			self.info = _logProxy("info");
			self.warn = _logProxy("warn");
			self.error = _logProxy("error");
		}
		/** Get the singleton instance of the DiagAPI API */
		DiagAPI.instance = function() {
			if (!this._instance) this._instance = new DiagAPI();
			return this._instance;
		};
		return DiagAPI;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/baggage/internal/baggage-impl.js
var __read$2, __values, BaggageImpl;
var init_baggage_impl = __esmMin((() => {
	__read$2 = function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	__values = function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	BaggageImpl = function() {
		function BaggageImpl(entries) {
			this._entries = entries ? new Map(entries) : /* @__PURE__ */ new Map();
		}
		BaggageImpl.prototype.getEntry = function(key) {
			var entry = this._entries.get(key);
			if (!entry) return;
			return Object.assign({}, entry);
		};
		BaggageImpl.prototype.getAllEntries = function() {
			return Array.from(this._entries.entries()).map(function(_a) {
				var _b = __read$2(_a, 2);
				return [_b[0], _b[1]];
			});
		};
		BaggageImpl.prototype.setEntry = function(key, entry) {
			var newBaggage = new BaggageImpl(this._entries);
			newBaggage._entries.set(key, entry);
			return newBaggage;
		};
		BaggageImpl.prototype.removeEntry = function(key) {
			var newBaggage = new BaggageImpl(this._entries);
			newBaggage._entries.delete(key);
			return newBaggage;
		};
		BaggageImpl.prototype.removeEntries = function() {
			var e_1, _a;
			var keys = [];
			for (var _i = 0; _i < arguments.length; _i++) keys[_i] = arguments[_i];
			var newBaggage = new BaggageImpl(this._entries);
			try {
				for (var keys_1 = __values(keys), keys_1_1 = keys_1.next(); !keys_1_1.done; keys_1_1 = keys_1.next()) {
					var key = keys_1_1.value;
					newBaggage._entries.delete(key);
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (keys_1_1 && !keys_1_1.done && (_a = keys_1.return)) _a.call(keys_1);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			return newBaggage;
		};
		BaggageImpl.prototype.clear = function() {
			return new BaggageImpl();
		};
		return BaggageImpl;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/baggage/internal/symbol.js
var baggageEntryMetadataSymbol;
var init_symbol = __esmMin((() => {
	baggageEntryMetadataSymbol = Symbol("BaggageEntryMetadata");
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/baggage/utils.js
/**
* Create a new Baggage with optional entries
*
* @param entries An array of baggage entries the new baggage should contain
*/
function createBaggage(entries) {
	if (entries === void 0) entries = {};
	return new BaggageImpl(new Map(Object.entries(entries)));
}
/**
* Create a serializable BaggageEntryMetadata object from a string.
*
* @param str string metadata. Format is currently not defined by the spec and has no special meaning.
*
*/
function baggageEntryMetadataFromString(str) {
	if (typeof str !== "string") {
		diag$1.error("Cannot create baggage metadata from unknown type: " + typeof str);
		str = "";
	}
	return {
		__TYPE__: baggageEntryMetadataSymbol,
		toString: function() {
			return str;
		}
	};
}
var diag$1;
var init_utils$1 = __esmMin((() => {
	init_diag();
	init_baggage_impl();
	init_symbol();
	diag$1 = DiagAPI.instance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/context/context.js
/** Get a key to uniquely identify a context value */
function createContextKey(description) {
	return Symbol.for(description);
}
var BaseContext, ROOT_CONTEXT;
var init_context$1 = __esmMin((() => {
	BaseContext = function() {
		/**
		* Construct a new context which inherits values from an optional parent context.
		*
		* @param parentContext a context from which to inherit values
		*/
		function BaseContext(parentContext) {
			var self = this;
			self._currentContext = parentContext ? new Map(parentContext) : /* @__PURE__ */ new Map();
			self.getValue = function(key) {
				return self._currentContext.get(key);
			};
			self.setValue = function(key, value) {
				var context = new BaseContext(self._currentContext);
				context._currentContext.set(key, value);
				return context;
			};
			self.deleteValue = function(key) {
				var context = new BaseContext(self._currentContext);
				context._currentContext.delete(key);
				return context;
			};
		}
		return BaseContext;
	}();
	ROOT_CONTEXT = new BaseContext();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/consoleLogger.js
var consoleMap, DiagConsoleLogger;
var init_consoleLogger = __esmMin((() => {
	consoleMap = [
		{
			n: "error",
			c: "error"
		},
		{
			n: "warn",
			c: "warn"
		},
		{
			n: "info",
			c: "info"
		},
		{
			n: "debug",
			c: "debug"
		},
		{
			n: "verbose",
			c: "trace"
		}
	];
	DiagConsoleLogger = function() {
		function DiagConsoleLogger() {
			function _consoleFunc(funcName) {
				return function() {
					var args = [];
					for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
					if (console) {
						var theFunc = console[funcName];
						if (typeof theFunc !== "function") theFunc = console.log;
						if (typeof theFunc === "function") return theFunc.apply(console, args);
					}
				};
			}
			for (var i = 0; i < consoleMap.length; i++) this[consoleMap[i].n] = _consoleFunc(consoleMap[i].c);
		}
		return DiagConsoleLogger;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/metrics/NoopMeter.js
/**
* Create a no-op Meter
*/
function createNoopMeter() {
	return NOOP_METER;
}
var __extends, NoopMeter, NoopMetric, NoopCounterMetric, NoopUpDownCounterMetric, NoopGaugeMetric, NoopHistogramMetric, NoopObservableMetric, NoopObservableCounterMetric, NoopObservableGaugeMetric, NoopObservableUpDownCounterMetric, NOOP_METER, NOOP_COUNTER_METRIC, NOOP_GAUGE_METRIC, NOOP_HISTOGRAM_METRIC, NOOP_UP_DOWN_COUNTER_METRIC, NOOP_OBSERVABLE_COUNTER_METRIC, NOOP_OBSERVABLE_GAUGE_METRIC, NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
var init_NoopMeter = __esmMin((() => {
	__extends = (function() {
		var extendStatics = function(d, b) {
			extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
				d.__proto__ = b;
			} || function(d, b) {
				for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
			};
			return extendStatics(d, b);
		};
		return function(d, b) {
			if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
			extendStatics(d, b);
			function __() {
				this.constructor = d;
			}
			d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
		};
	})();
	NoopMeter = function() {
		function NoopMeter() {}
		/**
		* @see {@link Meter.createGauge}
		*/
		NoopMeter.prototype.createGauge = function(_name, _options) {
			return NOOP_GAUGE_METRIC;
		};
		/**
		* @see {@link Meter.createHistogram}
		*/
		NoopMeter.prototype.createHistogram = function(_name, _options) {
			return NOOP_HISTOGRAM_METRIC;
		};
		/**
		* @see {@link Meter.createCounter}
		*/
		NoopMeter.prototype.createCounter = function(_name, _options) {
			return NOOP_COUNTER_METRIC;
		};
		/**
		* @see {@link Meter.createUpDownCounter}
		*/
		NoopMeter.prototype.createUpDownCounter = function(_name, _options) {
			return NOOP_UP_DOWN_COUNTER_METRIC;
		};
		/**
		* @see {@link Meter.createObservableGauge}
		*/
		NoopMeter.prototype.createObservableGauge = function(_name, _options) {
			return NOOP_OBSERVABLE_GAUGE_METRIC;
		};
		/**
		* @see {@link Meter.createObservableCounter}
		*/
		NoopMeter.prototype.createObservableCounter = function(_name, _options) {
			return NOOP_OBSERVABLE_COUNTER_METRIC;
		};
		/**
		* @see {@link Meter.createObservableUpDownCounter}
		*/
		NoopMeter.prototype.createObservableUpDownCounter = function(_name, _options) {
			return NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
		};
		/**
		* @see {@link Meter.addBatchObservableCallback}
		*/
		NoopMeter.prototype.addBatchObservableCallback = function(_callback, _observables) {};
		/**
		* @see {@link Meter.removeBatchObservableCallback}
		*/
		NoopMeter.prototype.removeBatchObservableCallback = function(_callback) {};
		return NoopMeter;
	}();
	NoopMetric = function() {
		function NoopMetric() {}
		return NoopMetric;
	}();
	NoopCounterMetric = function(_super) {
		__extends(NoopCounterMetric, _super);
		function NoopCounterMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		NoopCounterMetric.prototype.add = function(_value, _attributes) {};
		return NoopCounterMetric;
	}(NoopMetric);
	NoopUpDownCounterMetric = function(_super) {
		__extends(NoopUpDownCounterMetric, _super);
		function NoopUpDownCounterMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		NoopUpDownCounterMetric.prototype.add = function(_value, _attributes) {};
		return NoopUpDownCounterMetric;
	}(NoopMetric);
	NoopGaugeMetric = function(_super) {
		__extends(NoopGaugeMetric, _super);
		function NoopGaugeMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		NoopGaugeMetric.prototype.record = function(_value, _attributes) {};
		return NoopGaugeMetric;
	}(NoopMetric);
	NoopHistogramMetric = function(_super) {
		__extends(NoopHistogramMetric, _super);
		function NoopHistogramMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		NoopHistogramMetric.prototype.record = function(_value, _attributes) {};
		return NoopHistogramMetric;
	}(NoopMetric);
	NoopObservableMetric = function() {
		function NoopObservableMetric() {}
		NoopObservableMetric.prototype.addCallback = function(_callback) {};
		NoopObservableMetric.prototype.removeCallback = function(_callback) {};
		return NoopObservableMetric;
	}();
	NoopObservableCounterMetric = function(_super) {
		__extends(NoopObservableCounterMetric, _super);
		function NoopObservableCounterMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		return NoopObservableCounterMetric;
	}(NoopObservableMetric);
	NoopObservableGaugeMetric = function(_super) {
		__extends(NoopObservableGaugeMetric, _super);
		function NoopObservableGaugeMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		return NoopObservableGaugeMetric;
	}(NoopObservableMetric);
	NoopObservableUpDownCounterMetric = function(_super) {
		__extends(NoopObservableUpDownCounterMetric, _super);
		function NoopObservableUpDownCounterMetric() {
			return _super !== null && _super.apply(this, arguments) || this;
		}
		return NoopObservableUpDownCounterMetric;
	}(NoopObservableMetric);
	NOOP_METER = new NoopMeter();
	NOOP_COUNTER_METRIC = new NoopCounterMetric();
	NOOP_GAUGE_METRIC = new NoopGaugeMetric();
	NOOP_HISTOGRAM_METRIC = new NoopHistogramMetric();
	NOOP_UP_DOWN_COUNTER_METRIC = new NoopUpDownCounterMetric();
	NOOP_OBSERVABLE_COUNTER_METRIC = new NoopObservableCounterMetric();
	NOOP_OBSERVABLE_GAUGE_METRIC = new NoopObservableGaugeMetric();
	NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new NoopObservableUpDownCounterMetric();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/metrics/Metric.js
var ValueType;
var init_Metric = __esmMin((() => {
	(function(ValueType) {
		ValueType[ValueType["INT"] = 0] = "INT";
		ValueType[ValueType["DOUBLE"] = 1] = "DOUBLE";
	})(ValueType || (ValueType = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/propagation/TextMapPropagator.js
var defaultTextMapGetter, defaultTextMapSetter;
var init_TextMapPropagator = __esmMin((() => {
	defaultTextMapGetter = {
		get: function(carrier, key) {
			if (carrier == null) return;
			return carrier[key];
		},
		keys: function(carrier) {
			if (carrier == null) return [];
			return Object.keys(carrier);
		}
	};
	defaultTextMapSetter = { set: function(carrier, key, value) {
		if (carrier == null) return;
		carrier[key] = value;
	} };
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/context/NoopContextManager.js
var __read$1, __spreadArray$1, NoopContextManager;
var init_NoopContextManager = __esmMin((() => {
	init_context$1();
	__read$1 = function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	__spreadArray$1 = function(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	};
	NoopContextManager = function() {
		function NoopContextManager() {}
		NoopContextManager.prototype.active = function() {
			return ROOT_CONTEXT;
		};
		NoopContextManager.prototype.with = function(_context, fn, thisArg) {
			var args = [];
			for (var _i = 3; _i < arguments.length; _i++) args[_i - 3] = arguments[_i];
			return fn.call.apply(fn, __spreadArray$1([thisArg], __read$1(args), false));
		};
		NoopContextManager.prototype.bind = function(_context, target) {
			return target;
		};
		NoopContextManager.prototype.enable = function() {
			return this;
		};
		NoopContextManager.prototype.disable = function() {
			return this;
		};
		return NoopContextManager;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/context.js
var __read, __spreadArray, API_NAME$3, NOOP_CONTEXT_MANAGER, ContextAPI;
var init_context = __esmMin((() => {
	init_NoopContextManager();
	init_global_utils();
	init_diag();
	__read = function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	__spreadArray = function(to, from, pack) {
		if (pack || arguments.length === 2) {
			for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
				if (!ar) ar = Array.prototype.slice.call(from, 0, i);
				ar[i] = from[i];
			}
		}
		return to.concat(ar || Array.prototype.slice.call(from));
	};
	API_NAME$3 = "context";
	NOOP_CONTEXT_MANAGER = new NoopContextManager();
	ContextAPI = function() {
		/** Empty private constructor prevents end users from constructing a new instance of the API */
		function ContextAPI() {}
		/** Get the singleton instance of the Context API */
		ContextAPI.getInstance = function() {
			if (!this._instance) this._instance = new ContextAPI();
			return this._instance;
		};
		/**
		* Set the current context manager.
		*
		* @returns true if the context manager was successfully registered, else false
		*/
		ContextAPI.prototype.setGlobalContextManager = function(contextManager) {
			return registerGlobal(API_NAME$3, contextManager, DiagAPI.instance());
		};
		/**
		* Get the currently active context
		*/
		ContextAPI.prototype.active = function() {
			return this._getContextManager().active();
		};
		/**
		* Execute a function with an active context
		*
		* @param context context to be active during function execution
		* @param fn function to execute in a context
		* @param thisArg optional receiver to be used for calling fn
		* @param args optional arguments forwarded to fn
		*/
		ContextAPI.prototype.with = function(context, fn, thisArg) {
			var _a;
			var args = [];
			for (var _i = 3; _i < arguments.length; _i++) args[_i - 3] = arguments[_i];
			return (_a = this._getContextManager()).with.apply(_a, __spreadArray([
				context,
				fn,
				thisArg
			], __read(args), false));
		};
		/**
		* Bind a context to a target function or event emitter
		*
		* @param context context to bind to the event emitter or function. Defaults to the currently active context
		* @param target function or event emitter to bind
		*/
		ContextAPI.prototype.bind = function(context, target) {
			return this._getContextManager().bind(context, target);
		};
		ContextAPI.prototype._getContextManager = function() {
			return getGlobal(API_NAME$3) || NOOP_CONTEXT_MANAGER;
		};
		/** Disable and remove the global context manager */
		ContextAPI.prototype.disable = function() {
			this._getContextManager().disable();
			unregisterGlobal(API_NAME$3, DiagAPI.instance());
		};
		return ContextAPI;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/trace_flags.js
var TraceFlags;
var init_trace_flags = __esmMin((() => {
	(function(TraceFlags) {
		/** Represents no flag set. */
		TraceFlags[TraceFlags["NONE"] = 0] = "NONE";
		/** Bit to represent whether trace is sampled in trace flags. */
		TraceFlags[TraceFlags["SAMPLED"] = 1] = "SAMPLED";
	})(TraceFlags || (TraceFlags = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/invalid-span-constants.js
var INVALID_SPANID, INVALID_TRACEID, INVALID_SPAN_CONTEXT;
var init_invalid_span_constants = __esmMin((() => {
	init_trace_flags();
	INVALID_SPANID = "0000000000000000";
	INVALID_TRACEID = "00000000000000000000000000000000";
	INVALID_SPAN_CONTEXT = {
		traceId: INVALID_TRACEID,
		spanId: INVALID_SPANID,
		traceFlags: TraceFlags.NONE
	};
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NonRecordingSpan.js
var NonRecordingSpan;
var init_NonRecordingSpan = __esmMin((() => {
	init_invalid_span_constants();
	NonRecordingSpan = function() {
		function NonRecordingSpan(_spanContext) {
			if (_spanContext === void 0) _spanContext = INVALID_SPAN_CONTEXT;
			this._spanContext = _spanContext;
		}
		NonRecordingSpan.prototype.spanContext = function() {
			return this._spanContext;
		};
		NonRecordingSpan.prototype.setAttribute = function(_key, _value) {
			return this;
		};
		NonRecordingSpan.prototype.setAttributes = function(_attributes) {
			return this;
		};
		NonRecordingSpan.prototype.addEvent = function(_name, _attributes) {
			return this;
		};
		NonRecordingSpan.prototype.addLink = function(_link) {
			return this;
		};
		NonRecordingSpan.prototype.addLinks = function(_links) {
			return this;
		};
		NonRecordingSpan.prototype.setStatus = function(_status) {
			return this;
		};
		NonRecordingSpan.prototype.updateName = function(_name) {
			return this;
		};
		NonRecordingSpan.prototype.end = function(_endTime) {};
		NonRecordingSpan.prototype.isRecording = function() {
			return false;
		};
		NonRecordingSpan.prototype.recordException = function(_exception, _time) {};
		return NonRecordingSpan;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/context-utils.js
/**
* Return the span if one exists
*
* @param context context to get span from
*/
function getSpan(context) {
	return context.getValue(SPAN_KEY) || void 0;
}
/**
* Gets the span from the current context, if one exists.
*/
function getActiveSpan() {
	return getSpan(ContextAPI.getInstance().active());
}
/**
* Set the span on a context
*
* @param context context to use as parent
* @param span span to set active
*/
function setSpan(context, span) {
	return context.setValue(SPAN_KEY, span);
}
/**
* Remove current span stored in the context
*
* @param context context to delete span from
*/
function deleteSpan(context) {
	return context.deleteValue(SPAN_KEY);
}
/**
* Wrap span context in a NoopSpan and set as span in a new
* context
*
* @param context context to set active span on
* @param spanContext span context to be wrapped
*/
function setSpanContext(context, spanContext) {
	return setSpan(context, new NonRecordingSpan(spanContext));
}
/**
* Get the span context of the span if it exists.
*
* @param context context to get values from
*/
function getSpanContext(context) {
	var _a;
	return (_a = getSpan(context)) === null || _a === void 0 ? void 0 : _a.spanContext();
}
var SPAN_KEY;
var init_context_utils = __esmMin((() => {
	init_context$1();
	init_NonRecordingSpan();
	init_context();
	SPAN_KEY = createContextKey("OpenTelemetry Context Key SPAN");
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/spancontext-utils.js
function isValidTraceId(traceId) {
	return VALID_TRACEID_REGEX.test(traceId) && traceId !== "00000000000000000000000000000000";
}
function isValidSpanId(spanId) {
	return VALID_SPANID_REGEX.test(spanId) && spanId !== "0000000000000000";
}
/**
* Returns true if this {@link SpanContext} is valid.
* @return true if this {@link SpanContext} is valid.
*/
function isSpanContextValid(spanContext) {
	return isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
}
/**
* Wrap the given {@link SpanContext} in a new non-recording {@link Span}
*
* @param spanContext span context to be wrapped
* @returns a new non-recording {@link Span} with the provided context
*/
function wrapSpanContext(spanContext) {
	return new NonRecordingSpan(spanContext);
}
var VALID_TRACEID_REGEX, VALID_SPANID_REGEX;
var init_spancontext_utils = __esmMin((() => {
	init_invalid_span_constants();
	init_NonRecordingSpan();
	VALID_TRACEID_REGEX = /^([0-9a-f]{32})$/i;
	VALID_SPANID_REGEX = /^[0-9a-f]{16}$/i;
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NoopTracer.js
function isSpanContext(spanContext) {
	return typeof spanContext === "object" && typeof spanContext["spanId"] === "string" && typeof spanContext["traceId"] === "string" && typeof spanContext["traceFlags"] === "number";
}
var contextApi, NoopTracer;
var init_NoopTracer = __esmMin((() => {
	init_context();
	init_context_utils();
	init_NonRecordingSpan();
	init_spancontext_utils();
	contextApi = ContextAPI.getInstance();
	NoopTracer = function() {
		function NoopTracer() {}
		NoopTracer.prototype.startSpan = function(name, options, context) {
			if (context === void 0) context = contextApi.active();
			if (Boolean(options === null || options === void 0 ? void 0 : options.root)) return new NonRecordingSpan();
			var parentFromContext = context && getSpanContext(context);
			if (isSpanContext(parentFromContext) && isSpanContextValid(parentFromContext)) return new NonRecordingSpan(parentFromContext);
			else return new NonRecordingSpan();
		};
		NoopTracer.prototype.startActiveSpan = function(name, arg2, arg3, arg4) {
			var opts;
			var ctx;
			var fn;
			if (arguments.length < 2) return;
			else if (arguments.length === 2) fn = arg2;
			else if (arguments.length === 3) {
				opts = arg2;
				fn = arg3;
			} else {
				opts = arg2;
				ctx = arg3;
				fn = arg4;
			}
			var parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
			var span = this.startSpan(name, opts, parentContext);
			var contextWithSpanSet = setSpan(parentContext, span);
			return contextApi.with(contextWithSpanSet, fn, void 0, span);
		};
		return NoopTracer;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/ProxyTracer.js
var NOOP_TRACER, ProxyTracer;
var init_ProxyTracer = __esmMin((() => {
	init_NoopTracer();
	NOOP_TRACER = new NoopTracer();
	ProxyTracer = function() {
		function ProxyTracer(_provider, name, version, options) {
			this._provider = _provider;
			this.name = name;
			this.version = version;
			this.options = options;
		}
		ProxyTracer.prototype.startSpan = function(name, options, context) {
			return this._getTracer().startSpan(name, options, context);
		};
		ProxyTracer.prototype.startActiveSpan = function(_name, _options, _context, _fn) {
			var tracer = this._getTracer();
			return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
		};
		/**
		* Try to get a tracer from the proxy tracer provider.
		* If the proxy tracer provider has no delegate, return a noop tracer.
		*/
		ProxyTracer.prototype._getTracer = function() {
			if (this._delegate) return this._delegate;
			var tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
			if (!tracer) return NOOP_TRACER;
			this._delegate = tracer;
			return this._delegate;
		};
		return ProxyTracer;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NoopTracerProvider.js
var NoopTracerProvider;
var init_NoopTracerProvider = __esmMin((() => {
	init_NoopTracer();
	NoopTracerProvider = function() {
		function NoopTracerProvider() {}
		NoopTracerProvider.prototype.getTracer = function(_name, _version, _options) {
			return new NoopTracer();
		};
		return NoopTracerProvider;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/ProxyTracerProvider.js
var NOOP_TRACER_PROVIDER, ProxyTracerProvider;
var init_ProxyTracerProvider = __esmMin((() => {
	init_ProxyTracer();
	init_NoopTracerProvider();
	NOOP_TRACER_PROVIDER = new NoopTracerProvider();
	ProxyTracerProvider = function() {
		function ProxyTracerProvider() {}
		/**
		* Get a {@link ProxyTracer}
		*/
		ProxyTracerProvider.prototype.getTracer = function(name, version, options) {
			var _a;
			return (_a = this.getDelegateTracer(name, version, options)) !== null && _a !== void 0 ? _a : new ProxyTracer(this, name, version, options);
		};
		ProxyTracerProvider.prototype.getDelegate = function() {
			var _a;
			return (_a = this._delegate) !== null && _a !== void 0 ? _a : NOOP_TRACER_PROVIDER;
		};
		/**
		* Set the delegate tracer provider
		*/
		ProxyTracerProvider.prototype.setDelegate = function(delegate) {
			this._delegate = delegate;
		};
		ProxyTracerProvider.prototype.getDelegateTracer = function(name, version, options) {
			var _a;
			return (_a = this._delegate) === null || _a === void 0 ? void 0 : _a.getTracer(name, version, options);
		};
		return ProxyTracerProvider;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/SamplingResult.js
var SamplingDecision;
var init_SamplingResult = __esmMin((() => {
	(function(SamplingDecision) {
		/**
		* `Span.isRecording() === false`, span will not be recorded and all events
		* and attributes will be dropped.
		*/
		SamplingDecision[SamplingDecision["NOT_RECORD"] = 0] = "NOT_RECORD";
		/**
		* `Span.isRecording() === true`, but `Sampled` flag in {@link TraceFlags}
		* MUST NOT be set.
		*/
		SamplingDecision[SamplingDecision["RECORD"] = 1] = "RECORD";
		/**
		* `Span.isRecording() === true` AND `Sampled` flag in {@link TraceFlags}
		* MUST be set.
		*/
		SamplingDecision[SamplingDecision["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
	})(SamplingDecision || (SamplingDecision = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/span_kind.js
var SpanKind;
var init_span_kind = __esmMin((() => {
	(function(SpanKind) {
		/** Default value. Indicates that the span is used internally. */
		SpanKind[SpanKind["INTERNAL"] = 0] = "INTERNAL";
		/**
		* Indicates that the span covers server-side handling of an RPC or other
		* remote request.
		*/
		SpanKind[SpanKind["SERVER"] = 1] = "SERVER";
		/**
		* Indicates that the span covers the client-side wrapper around an RPC or
		* other remote request.
		*/
		SpanKind[SpanKind["CLIENT"] = 2] = "CLIENT";
		/**
		* Indicates that the span describes producer sending a message to a
		* broker. Unlike client and server, there is no direct critical path latency
		* relationship between producer and consumer spans.
		*/
		SpanKind[SpanKind["PRODUCER"] = 3] = "PRODUCER";
		/**
		* Indicates that the span describes consumer receiving a message from a
		* broker. Unlike client and server, there is no direct critical path latency
		* relationship between producer and consumer spans.
		*/
		SpanKind[SpanKind["CONSUMER"] = 4] = "CONSUMER";
	})(SpanKind || (SpanKind = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/status.js
var SpanStatusCode;
var init_status = __esmMin((() => {
	(function(SpanStatusCode) {
		/**
		* The default status.
		*/
		SpanStatusCode[SpanStatusCode["UNSET"] = 0] = "UNSET";
		/**
		* The operation has been validated by an Application developer or
		* Operator to have completed successfully.
		*/
		SpanStatusCode[SpanStatusCode["OK"] = 1] = "OK";
		/**
		* The operation contains an error.
		*/
		SpanStatusCode[SpanStatusCode["ERROR"] = 2] = "ERROR";
	})(SpanStatusCode || (SpanStatusCode = {}));
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/internal/tracestate-validators.js
/**
* Key is opaque string up to 256 characters printable. It MUST begin with a
* lowercase letter, and can only contain lowercase letters a-z, digits 0-9,
* underscores _, dashes -, asterisks *, and forward slashes /.
* For multi-tenant vendor scenarios, an at sign (@) can be used to prefix the
* vendor name. Vendors SHOULD set the tenant ID at the beginning of the key.
* see https://www.w3.org/TR/trace-context/#key
*/
function validateKey(key) {
	return VALID_KEY_REGEX.test(key);
}
/**
* Value is opaque string up to 256 characters printable ASCII RFC0020
* characters (i.e., the range 0x20 to 0x7E) except comma , and =.
*/
function validateValue(value) {
	return VALID_VALUE_BASE_REGEX.test(value) && !INVALID_VALUE_COMMA_EQUAL_REGEX.test(value);
}
var VALID_KEY_CHAR_RANGE, VALID_KEY, VALID_VENDOR_KEY, VALID_KEY_REGEX, VALID_VALUE_BASE_REGEX, INVALID_VALUE_COMMA_EQUAL_REGEX;
var init_tracestate_validators = __esmMin((() => {
	VALID_KEY_CHAR_RANGE = "[_0-9a-z-*/]";
	VALID_KEY = "[a-z]" + VALID_KEY_CHAR_RANGE + "{0,255}";
	VALID_VENDOR_KEY = "[a-z0-9]" + VALID_KEY_CHAR_RANGE + "{0,240}@[a-z]" + VALID_KEY_CHAR_RANGE + "{0,13}";
	VALID_KEY_REGEX = new RegExp("^(?:" + VALID_KEY + "|" + VALID_VENDOR_KEY + ")$");
	VALID_VALUE_BASE_REGEX = /^[ -~]{0,255}[!-~]$/;
	INVALID_VALUE_COMMA_EQUAL_REGEX = /,|=/;
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/internal/tracestate-impl.js
var MAX_TRACE_STATE_ITEMS, MAX_TRACE_STATE_LEN, LIST_MEMBERS_SEPARATOR, LIST_MEMBER_KEY_VALUE_SPLITTER, TraceStateImpl;
var init_tracestate_impl = __esmMin((() => {
	init_tracestate_validators();
	MAX_TRACE_STATE_ITEMS = 32;
	MAX_TRACE_STATE_LEN = 512;
	LIST_MEMBERS_SEPARATOR = ",";
	LIST_MEMBER_KEY_VALUE_SPLITTER = "=";
	TraceStateImpl = function() {
		function TraceStateImpl(rawTraceState) {
			this._internalState = /* @__PURE__ */ new Map();
			if (rawTraceState) this._parse(rawTraceState);
		}
		TraceStateImpl.prototype.set = function(key, value) {
			var traceState = this._clone();
			if (traceState._internalState.has(key)) traceState._internalState.delete(key);
			traceState._internalState.set(key, value);
			return traceState;
		};
		TraceStateImpl.prototype.unset = function(key) {
			var traceState = this._clone();
			traceState._internalState.delete(key);
			return traceState;
		};
		TraceStateImpl.prototype.get = function(key) {
			return this._internalState.get(key);
		};
		TraceStateImpl.prototype.serialize = function() {
			var _this = this;
			return this._keys().reduce(function(agg, key) {
				agg.push(key + LIST_MEMBER_KEY_VALUE_SPLITTER + _this.get(key));
				return agg;
			}, []).join(LIST_MEMBERS_SEPARATOR);
		};
		TraceStateImpl.prototype._parse = function(rawTraceState) {
			if (rawTraceState.length > MAX_TRACE_STATE_LEN) return;
			this._internalState = rawTraceState.split(LIST_MEMBERS_SEPARATOR).reverse().reduce(function(agg, part) {
				var listMember = part.trim();
				var i = listMember.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
				if (i !== -1) {
					var key = listMember.slice(0, i);
					var value = listMember.slice(i + 1, part.length);
					if (validateKey(key) && validateValue(value)) agg.set(key, value);
				}
				return agg;
			}, /* @__PURE__ */ new Map());
			if (this._internalState.size > MAX_TRACE_STATE_ITEMS) this._internalState = new Map(Array.from(this._internalState.entries()).reverse().slice(0, MAX_TRACE_STATE_ITEMS));
		};
		TraceStateImpl.prototype._keys = function() {
			return Array.from(this._internalState.keys()).reverse();
		};
		TraceStateImpl.prototype._clone = function() {
			var traceState = new TraceStateImpl();
			traceState._internalState = new Map(this._internalState);
			return traceState;
		};
		return TraceStateImpl;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/internal/utils.js
function createTraceState(rawTraceState) {
	return new TraceStateImpl(rawTraceState);
}
var init_utils = __esmMin((() => {
	init_tracestate_impl();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/context-api.js
var context;
var init_context_api = __esmMin((() => {
	init_context();
	context = ContextAPI.getInstance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag-api.js
var diag;
var init_diag_api = __esmMin((() => {
	init_diag();
	diag = DiagAPI.instance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/metrics/NoopMeterProvider.js
var NoopMeterProvider, NOOP_METER_PROVIDER;
var init_NoopMeterProvider = __esmMin((() => {
	init_NoopMeter();
	NoopMeterProvider = function() {
		function NoopMeterProvider() {}
		NoopMeterProvider.prototype.getMeter = function(_name, _version, _options) {
			return NOOP_METER;
		};
		return NoopMeterProvider;
	}();
	NOOP_METER_PROVIDER = new NoopMeterProvider();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/metrics.js
var API_NAME$2, MetricsAPI;
var init_metrics = __esmMin((() => {
	init_NoopMeterProvider();
	init_global_utils();
	init_diag();
	API_NAME$2 = "metrics";
	MetricsAPI = function() {
		/** Empty private constructor prevents end users from constructing a new instance of the API */
		function MetricsAPI() {}
		/** Get the singleton instance of the Metrics API */
		MetricsAPI.getInstance = function() {
			if (!this._instance) this._instance = new MetricsAPI();
			return this._instance;
		};
		/**
		* Set the current global meter provider.
		* Returns true if the meter provider was successfully registered, else false.
		*/
		MetricsAPI.prototype.setGlobalMeterProvider = function(provider) {
			return registerGlobal(API_NAME$2, provider, DiagAPI.instance());
		};
		/**
		* Returns the global meter provider.
		*/
		MetricsAPI.prototype.getMeterProvider = function() {
			return getGlobal(API_NAME$2) || NOOP_METER_PROVIDER;
		};
		/**
		* Returns a meter from the global meter provider.
		*/
		MetricsAPI.prototype.getMeter = function(name, version, options) {
			return this.getMeterProvider().getMeter(name, version, options);
		};
		/** Remove the global meter provider */
		MetricsAPI.prototype.disable = function() {
			unregisterGlobal(API_NAME$2, DiagAPI.instance());
		};
		return MetricsAPI;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/metrics-api.js
var metrics;
var init_metrics_api = __esmMin((() => {
	init_metrics();
	metrics = MetricsAPI.getInstance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/propagation/NoopTextMapPropagator.js
var NoopTextMapPropagator;
var init_NoopTextMapPropagator = __esmMin((() => {
	NoopTextMapPropagator = function() {
		function NoopTextMapPropagator() {}
		/** Noop inject function does nothing */
		NoopTextMapPropagator.prototype.inject = function(_context, _carrier) {};
		/** Noop extract function does nothing and returns the input context */
		NoopTextMapPropagator.prototype.extract = function(context, _carrier) {
			return context;
		};
		NoopTextMapPropagator.prototype.fields = function() {
			return [];
		};
		return NoopTextMapPropagator;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/baggage/context-helpers.js
/**
* Retrieve the current baggage from the given context
*
* @param {Context} Context that manage all context values
* @returns {Baggage} Extracted baggage from the context
*/
function getBaggage(context) {
	return context.getValue(BAGGAGE_KEY) || void 0;
}
/**
* Retrieve the current baggage from the active/current context
*
* @returns {Baggage} Extracted baggage from the context
*/
function getActiveBaggage() {
	return getBaggage(ContextAPI.getInstance().active());
}
/**
* Store a baggage in the given context
*
* @param {Context} Context that manage all context values
* @param {Baggage} baggage that will be set in the actual context
*/
function setBaggage(context, baggage) {
	return context.setValue(BAGGAGE_KEY, baggage);
}
/**
* Delete the baggage stored in the given context
*
* @param {Context} Context that manage all context values
*/
function deleteBaggage(context) {
	return context.deleteValue(BAGGAGE_KEY);
}
var BAGGAGE_KEY;
var init_context_helpers = __esmMin((() => {
	init_context();
	init_context$1();
	BAGGAGE_KEY = createContextKey("OpenTelemetry Baggage Key");
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/propagation.js
var API_NAME$1, NOOP_TEXT_MAP_PROPAGATOR, PropagationAPI;
var init_propagation = __esmMin((() => {
	init_global_utils();
	init_NoopTextMapPropagator();
	init_TextMapPropagator();
	init_context_helpers();
	init_utils$1();
	init_diag();
	API_NAME$1 = "propagation";
	NOOP_TEXT_MAP_PROPAGATOR = new NoopTextMapPropagator();
	PropagationAPI = function() {
		/** Empty private constructor prevents end users from constructing a new instance of the API */
		function PropagationAPI() {
			this.createBaggage = createBaggage;
			this.getBaggage = getBaggage;
			this.getActiveBaggage = getActiveBaggage;
			this.setBaggage = setBaggage;
			this.deleteBaggage = deleteBaggage;
		}
		/** Get the singleton instance of the Propagator API */
		PropagationAPI.getInstance = function() {
			if (!this._instance) this._instance = new PropagationAPI();
			return this._instance;
		};
		/**
		* Set the current propagator.
		*
		* @returns true if the propagator was successfully registered, else false
		*/
		PropagationAPI.prototype.setGlobalPropagator = function(propagator) {
			return registerGlobal(API_NAME$1, propagator, DiagAPI.instance());
		};
		/**
		* Inject context into a carrier to be propagated inter-process
		*
		* @param context Context carrying tracing data to inject
		* @param carrier carrier to inject context into
		* @param setter Function used to set values on the carrier
		*/
		PropagationAPI.prototype.inject = function(context, carrier, setter) {
			if (setter === void 0) setter = defaultTextMapSetter;
			return this._getGlobalPropagator().inject(context, carrier, setter);
		};
		/**
		* Extract context from a carrier
		*
		* @param context Context which the newly created context will inherit from
		* @param carrier Carrier to extract context from
		* @param getter Function used to extract keys from a carrier
		*/
		PropagationAPI.prototype.extract = function(context, carrier, getter) {
			if (getter === void 0) getter = defaultTextMapGetter;
			return this._getGlobalPropagator().extract(context, carrier, getter);
		};
		/**
		* Return a list of all fields which may be used by the propagator.
		*/
		PropagationAPI.prototype.fields = function() {
			return this._getGlobalPropagator().fields();
		};
		/** Remove the global propagator */
		PropagationAPI.prototype.disable = function() {
			unregisterGlobal(API_NAME$1, DiagAPI.instance());
		};
		PropagationAPI.prototype._getGlobalPropagator = function() {
			return getGlobal(API_NAME$1) || NOOP_TEXT_MAP_PROPAGATOR;
		};
		return PropagationAPI;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/propagation-api.js
var propagation;
var init_propagation_api = __esmMin((() => {
	init_propagation();
	propagation = PropagationAPI.getInstance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/trace.js
var API_NAME, TraceAPI;
var init_trace = __esmMin((() => {
	init_global_utils();
	init_ProxyTracerProvider();
	init_spancontext_utils();
	init_context_utils();
	init_diag();
	API_NAME = "trace";
	TraceAPI = function() {
		/** Empty private constructor prevents end users from constructing a new instance of the API */
		function TraceAPI() {
			this._proxyTracerProvider = new ProxyTracerProvider();
			this.wrapSpanContext = wrapSpanContext;
			this.isSpanContextValid = isSpanContextValid;
			this.deleteSpan = deleteSpan;
			this.getSpan = getSpan;
			this.getActiveSpan = getActiveSpan;
			this.getSpanContext = getSpanContext;
			this.setSpan = setSpan;
			this.setSpanContext = setSpanContext;
		}
		/** Get the singleton instance of the Trace API */
		TraceAPI.getInstance = function() {
			if (!this._instance) this._instance = new TraceAPI();
			return this._instance;
		};
		/**
		* Set the current global tracer.
		*
		* @returns true if the tracer provider was successfully registered, else false
		*/
		TraceAPI.prototype.setGlobalTracerProvider = function(provider) {
			var success = registerGlobal(API_NAME, this._proxyTracerProvider, DiagAPI.instance());
			if (success) this._proxyTracerProvider.setDelegate(provider);
			return success;
		};
		/**
		* Returns the global tracer provider.
		*/
		TraceAPI.prototype.getTracerProvider = function() {
			return getGlobal(API_NAME) || this._proxyTracerProvider;
		};
		/**
		* Returns a tracer from the global tracer provider.
		*/
		TraceAPI.prototype.getTracer = function(name, version) {
			return this.getTracerProvider().getTracer(name, version);
		};
		/** Remove the global tracer provider */
		TraceAPI.prototype.disable = function() {
			unregisterGlobal(API_NAME, DiagAPI.instance());
			this._proxyTracerProvider = new ProxyTracerProvider();
		};
		return TraceAPI;
	}();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace-api.js
var trace;
var init_trace_api = __esmMin((() => {
	init_trace();
	trace = TraceAPI.getInstance();
}));
//#endregion
//#region node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/index.js
var esm_exports = /* @__PURE__ */ __exportAll({
	DiagConsoleLogger: () => DiagConsoleLogger,
	DiagLogLevel: () => DiagLogLevel,
	INVALID_SPANID: () => INVALID_SPANID,
	INVALID_SPAN_CONTEXT: () => INVALID_SPAN_CONTEXT,
	INVALID_TRACEID: () => INVALID_TRACEID,
	ProxyTracer: () => ProxyTracer,
	ProxyTracerProvider: () => ProxyTracerProvider,
	ROOT_CONTEXT: () => ROOT_CONTEXT,
	SamplingDecision: () => SamplingDecision,
	SpanKind: () => SpanKind,
	SpanStatusCode: () => SpanStatusCode,
	TraceFlags: () => TraceFlags,
	ValueType: () => ValueType,
	baggageEntryMetadataFromString: () => baggageEntryMetadataFromString,
	context: () => context,
	createContextKey: () => createContextKey,
	createNoopMeter: () => createNoopMeter,
	createTraceState: () => createTraceState,
	default: () => esm_default,
	defaultTextMapGetter: () => defaultTextMapGetter,
	defaultTextMapSetter: () => defaultTextMapSetter,
	diag: () => diag,
	isSpanContextValid: () => isSpanContextValid,
	isValidSpanId: () => isValidSpanId,
	isValidTraceId: () => isValidTraceId,
	metrics: () => metrics,
	propagation: () => propagation,
	trace: () => trace
});
var esm_default;
var init_esm = __esmMin((() => {
	init_utils$1();
	init_context$1();
	init_consoleLogger();
	init_types();
	init_NoopMeter();
	init_Metric();
	init_TextMapPropagator();
	init_ProxyTracer();
	init_ProxyTracerProvider();
	init_SamplingResult();
	init_span_kind();
	init_status();
	init_trace_flags();
	init_utils();
	init_spancontext_utils();
	init_invalid_span_constants();
	init_context_api();
	init_diag_api();
	init_metrics_api();
	init_propagation_api();
	init_trace_api();
	esm_default = {
		context,
		diag,
		metrics,
		propagation,
		trace
	};
}));
//#endregion
export { diag as a, metrics as i, init_esm as n, SpanStatusCode as o, trace as r, esm_exports as t };
