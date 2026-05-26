import { i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { t as require_src } from "./src-BbQYZdr4.js";
import { i as require_type, n as require_get_intrinsic, r as require_call_bind_apply_helpers, t as require_form_data } from "./form_data-B1QkBzKc.js";
//#region node_modules/@microsoft/teams.common/dist/events/event-emitter.js
var require_event_emitter = /* @__PURE__ */ __commonJSMin(((exports) => {
	var EventEmitter = class {
		index = -1;
		subscriptions = /* @__PURE__ */ new Map();
		on(event, handler) {
			const id = ++this.index;
			const subs = this.subscriptions.get(event) || [];
			subs.push({
				id,
				handler
			});
			this.subscriptions.set(event, subs);
			return id;
		}
		once(event, handler) {
			const id = this.on(event, (value) => {
				this.off(id);
				handler(value);
			});
			return id;
		}
		off(id) {
			for (const [_, subs] of this.subscriptions.entries()) {
				const i = subs.findIndex((s) => s.id === id);
				if (i === -1) continue;
				subs.splice(i, 1);
				return;
			}
		}
		emit(event, value) {
			const subs = this.subscriptions.get(event) || [];
			for (const sub of subs) sub.handler(value);
		}
	};
	exports.EventEmitter = EventEmitter;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/events/index.js
var require_events = /* @__PURE__ */ __commonJSMin(((exports) => {
	var eventEmitter = require_event_emitter();
	Object.keys(eventEmitter).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return eventEmitter[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/follow-redirects/debug.js
var require_debug = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var debug;
	module.exports = function() {
		if (!debug) {
			try {
				debug = require_src()("follow-redirects");
			} catch (error) {}
			if (typeof debug !== "function") debug = function() {};
		}
		debug.apply(null, arguments);
	};
}));
//#endregion
//#region node_modules/follow-redirects/index.js
var require_follow_redirects = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var url$1 = __require("url");
	var URL = url$1.URL;
	var http$1 = __require("http");
	var https$1 = __require("https");
	var Writable = __require("stream").Writable;
	var assert = __require("assert");
	var debug = require_debug();
	// istanbul ignore next
	(function detectUnsupportedEnvironment() {
		var looksLikeNode = typeof process !== "undefined";
		var looksLikeBrowser = typeof window !== "undefined" && typeof document !== "undefined";
		var looksLikeV8 = isFunction(Error.captureStackTrace);
		if (!looksLikeNode && (looksLikeBrowser || !looksLikeV8)) console.warn("The follow-redirects package should be excluded from browser builds.");
	})();
	var useNativeURL = false;
	try {
		assert(new URL(""));
	} catch (error) {
		useNativeURL = error.code === "ERR_INVALID_URL";
	}
	var sensitiveHeaders = [
		"Authorization",
		"Proxy-Authorization",
		"Cookie"
	];
	var preservedUrlFields = [
		"auth",
		"host",
		"hostname",
		"href",
		"path",
		"pathname",
		"port",
		"protocol",
		"query",
		"search",
		"hash"
	];
	var events = [
		"abort",
		"aborted",
		"connect",
		"error",
		"socket",
		"timeout"
	];
	var eventHandlers = Object.create(null);
	events.forEach(function(event) {
		eventHandlers[event] = function(arg1, arg2, arg3) {
			this._redirectable.emit(event, arg1, arg2, arg3);
		};
	});
	var InvalidUrlError = createErrorType("ERR_INVALID_URL", "Invalid URL", TypeError);
	var RedirectionError = createErrorType("ERR_FR_REDIRECTION_FAILURE", "Redirected request failed");
	var TooManyRedirectsError = createErrorType("ERR_FR_TOO_MANY_REDIRECTS", "Maximum number of redirects exceeded", RedirectionError);
	var MaxBodyLengthExceededError = createErrorType("ERR_FR_MAX_BODY_LENGTH_EXCEEDED", "Request body larger than maxBodyLength limit");
	var WriteAfterEndError = createErrorType("ERR_STREAM_WRITE_AFTER_END", "write after end");
	// istanbul ignore next
	var destroy = Writable.prototype.destroy || noop;
	function RedirectableRequest(options, responseCallback) {
		Writable.call(this);
		this._sanitizeOptions(options);
		this._options = options;
		this._ended = false;
		this._ending = false;
		this._redirectCount = 0;
		this._redirects = [];
		this._requestBodyLength = 0;
		this._requestBodyBuffers = [];
		if (responseCallback) this.on("response", responseCallback);
		var self = this;
		this._onNativeResponse = function(response) {
			try {
				self._processResponse(response);
			} catch (cause) {
				self.emit("error", cause instanceof RedirectionError ? cause : new RedirectionError({ cause }));
			}
		};
		this._headerFilter = new RegExp("^(?:" + sensitiveHeaders.concat(options.sensitiveHeaders).map(escapeRegex).join("|") + ")$", "i");
		this._performRequest();
	}
	RedirectableRequest.prototype = Object.create(Writable.prototype);
	RedirectableRequest.prototype.abort = function() {
		destroyRequest(this._currentRequest);
		this._currentRequest.abort();
		this.emit("abort");
	};
	RedirectableRequest.prototype.destroy = function(error) {
		destroyRequest(this._currentRequest, error);
		destroy.call(this, error);
		return this;
	};
	RedirectableRequest.prototype.write = function(data, encoding, callback) {
		if (this._ending) throw new WriteAfterEndError();
		if (!isString(data) && !isBuffer(data)) throw new TypeError("data should be a string, Buffer or Uint8Array");
		if (isFunction(encoding)) {
			callback = encoding;
			encoding = null;
		}
		if (data.length === 0) {
			if (callback) callback();
			return;
		}
		if (this._requestBodyLength + data.length <= this._options.maxBodyLength) {
			this._requestBodyLength += data.length;
			this._requestBodyBuffers.push({
				data,
				encoding
			});
			this._currentRequest.write(data, encoding, callback);
		} else {
			this.emit("error", new MaxBodyLengthExceededError());
			this.abort();
		}
	};
	RedirectableRequest.prototype.end = function(data, encoding, callback) {
		if (isFunction(data)) {
			callback = data;
			data = encoding = null;
		} else if (isFunction(encoding)) {
			callback = encoding;
			encoding = null;
		}
		if (!data) {
			this._ended = this._ending = true;
			this._currentRequest.end(null, null, callback);
		} else {
			var self = this;
			var currentRequest = this._currentRequest;
			this.write(data, encoding, function() {
				self._ended = true;
				currentRequest.end(null, null, callback);
			});
			this._ending = true;
		}
	};
	RedirectableRequest.prototype.setHeader = function(name, value) {
		this._options.headers[name] = value;
		this._currentRequest.setHeader(name, value);
	};
	RedirectableRequest.prototype.removeHeader = function(name) {
		delete this._options.headers[name];
		this._currentRequest.removeHeader(name);
	};
	RedirectableRequest.prototype.setTimeout = function(msecs, callback) {
		var self = this;
		function destroyOnTimeout(socket) {
			socket.setTimeout(msecs);
			socket.removeListener("timeout", socket.destroy);
			socket.addListener("timeout", socket.destroy);
		}
		function startTimer(socket) {
			if (self._timeout) clearTimeout(self._timeout);
			self._timeout = setTimeout(function() {
				self.emit("timeout");
				clearTimer();
			}, msecs);
			destroyOnTimeout(socket);
		}
		function clearTimer() {
			if (self._timeout) {
				clearTimeout(self._timeout);
				self._timeout = null;
			}
			self.removeListener("abort", clearTimer);
			self.removeListener("error", clearTimer);
			self.removeListener("response", clearTimer);
			self.removeListener("close", clearTimer);
			if (callback) self.removeListener("timeout", callback);
			if (!self.socket) self._currentRequest.removeListener("socket", startTimer);
		}
		if (callback) this.on("timeout", callback);
		if (this.socket) startTimer(this.socket);
		else this._currentRequest.once("socket", startTimer);
		this.on("socket", destroyOnTimeout);
		this.on("abort", clearTimer);
		this.on("error", clearTimer);
		this.on("response", clearTimer);
		this.on("close", clearTimer);
		return this;
	};
	[
		"flushHeaders",
		"getHeader",
		"setNoDelay",
		"setSocketKeepAlive"
	].forEach(function(method) {
		RedirectableRequest.prototype[method] = function(a, b) {
			return this._currentRequest[method](a, b);
		};
	});
	[
		"aborted",
		"connection",
		"socket"
	].forEach(function(property) {
		Object.defineProperty(RedirectableRequest.prototype, property, { get: function() {
			return this._currentRequest[property];
		} });
	});
	RedirectableRequest.prototype._sanitizeOptions = function(options) {
		if (!options.headers) options.headers = {};
		if (!isArray(options.sensitiveHeaders)) options.sensitiveHeaders = [];
		if (options.host) {
			if (!options.hostname) options.hostname = options.host;
			delete options.host;
		}
		if (!options.pathname && options.path) {
			var searchPos = options.path.indexOf("?");
			if (searchPos < 0) options.pathname = options.path;
			else {
				options.pathname = options.path.substring(0, searchPos);
				options.search = options.path.substring(searchPos);
			}
		}
	};
	RedirectableRequest.prototype._performRequest = function() {
		var protocol = this._options.protocol;
		var nativeProtocol = this._options.nativeProtocols[protocol];
		if (!nativeProtocol) throw new TypeError("Unsupported protocol " + protocol);
		if (this._options.agents) {
			var scheme = protocol.slice(0, -1);
			this._options.agent = this._options.agents[scheme];
		}
		var request = this._currentRequest = nativeProtocol.request(this._options, this._onNativeResponse);
		request._redirectable = this;
		for (var event of events) request.on(event, eventHandlers[event]);
		this._currentUrl = /^\//.test(this._options.path) ? url$1.format(this._options) : this._options.path;
		if (this._isRedirect) {
			var i = 0;
			var self = this;
			var buffers = this._requestBodyBuffers;
			(function writeNext(error) {
				// istanbul ignore else
				if (request === self._currentRequest) {
					// istanbul ignore if
					if (error) self.emit("error", error);
					else if (i < buffers.length) {
						var buffer = buffers[i++];
						// istanbul ignore else
						if (!request.finished) request.write(buffer.data, buffer.encoding, writeNext);
					} else if (self._ended) request.end();
				}
			})();
		}
	};
	RedirectableRequest.prototype._processResponse = function(response) {
		var statusCode = response.statusCode;
		if (this._options.trackRedirects) this._redirects.push({
			url: this._currentUrl,
			headers: response.headers,
			statusCode
		});
		var location = response.headers.location;
		if (!location || this._options.followRedirects === false || statusCode < 300 || statusCode >= 400) {
			response.responseUrl = this._currentUrl;
			response.redirects = this._redirects;
			this.emit("response", response);
			this._requestBodyBuffers = [];
			return;
		}
		destroyRequest(this._currentRequest);
		response.destroy();
		if (++this._redirectCount > this._options.maxRedirects) throw new TooManyRedirectsError();
		var requestHeaders;
		var beforeRedirect = this._options.beforeRedirect;
		if (beforeRedirect) requestHeaders = Object.assign({ Host: response.req.getHeader("host") }, this._options.headers);
		var method = this._options.method;
		if ((statusCode === 301 || statusCode === 302) && this._options.method === "POST" || statusCode === 303 && !/^(?:GET|HEAD)$/.test(this._options.method)) {
			this._options.method = "GET";
			this._requestBodyBuffers = [];
			removeMatchingHeaders(/^content-/i, this._options.headers);
		}
		var currentHostHeader = removeMatchingHeaders(/^host$/i, this._options.headers);
		var currentUrlParts = parseUrl(this._currentUrl);
		var currentHost = currentHostHeader || currentUrlParts.host;
		var currentUrl = /^\w+:/.test(location) ? this._currentUrl : url$1.format(Object.assign(currentUrlParts, { host: currentHost }));
		var redirectUrl = resolveUrl(location, currentUrl);
		debug("redirecting to", redirectUrl.href);
		this._isRedirect = true;
		spreadUrlObject(redirectUrl, this._options);
		if (redirectUrl.protocol !== currentUrlParts.protocol && redirectUrl.protocol !== "https:" || redirectUrl.host !== currentHost && !isSubdomain(redirectUrl.host, currentHost)) removeMatchingHeaders(this._headerFilter, this._options.headers);
		if (isFunction(beforeRedirect)) {
			var responseDetails = {
				headers: response.headers,
				statusCode
			};
			var requestDetails = {
				url: currentUrl,
				method,
				headers: requestHeaders
			};
			beforeRedirect(this._options, responseDetails, requestDetails);
			this._sanitizeOptions(this._options);
		}
		this._performRequest();
	};
	function wrap(protocols) {
		var exports$1 = {
			maxRedirects: 21,
			maxBodyLength: 10 * 1024 * 1024
		};
		var nativeProtocols = {};
		Object.keys(protocols).forEach(function(scheme) {
			var protocol = scheme + ":";
			var nativeProtocol = nativeProtocols[protocol] = protocols[scheme];
			var wrappedProtocol = exports$1[scheme] = Object.create(nativeProtocol);
			function request(input, options, callback) {
				if (isURL(input)) input = spreadUrlObject(input);
				else if (isString(input)) input = spreadUrlObject(parseUrl(input));
				else {
					callback = options;
					options = validateUrl(input);
					input = { protocol };
				}
				if (isFunction(options)) {
					callback = options;
					options = null;
				}
				options = Object.assign({
					maxRedirects: exports$1.maxRedirects,
					maxBodyLength: exports$1.maxBodyLength
				}, input, options);
				options.nativeProtocols = nativeProtocols;
				if (!isString(options.host) && !isString(options.hostname)) options.hostname = "::1";
				assert.equal(options.protocol, protocol, "protocol mismatch");
				debug("options", options);
				return new RedirectableRequest(options, callback);
			}
			function get(input, options, callback) {
				var wrappedRequest = wrappedProtocol.request(input, options, callback);
				wrappedRequest.end();
				return wrappedRequest;
			}
			Object.defineProperties(wrappedProtocol, {
				request: {
					value: request,
					configurable: true,
					enumerable: true,
					writable: true
				},
				get: {
					value: get,
					configurable: true,
					enumerable: true,
					writable: true
				}
			});
		});
		return exports$1;
	}
	function noop() {}
	function parseUrl(input) {
		var parsed;
		// istanbul ignore else
		if (useNativeURL) parsed = new URL(input);
		else {
			parsed = validateUrl(url$1.parse(input));
			if (!isString(parsed.protocol)) throw new InvalidUrlError({ input });
		}
		return parsed;
	}
	function resolveUrl(relative, base) {
		// istanbul ignore next
		return useNativeURL ? new URL(relative, base) : parseUrl(url$1.resolve(base, relative));
	}
	function validateUrl(input) {
		if (/^\[/.test(input.hostname) && !/^\[[:0-9a-f]+\]$/i.test(input.hostname)) throw new InvalidUrlError({ input: input.href || input });
		if (/^\[/.test(input.host) && !/^\[[:0-9a-f]+\](:\d+)?$/i.test(input.host)) throw new InvalidUrlError({ input: input.href || input });
		return input;
	}
	function spreadUrlObject(urlObject, target) {
		var spread = target || {};
		for (var key of preservedUrlFields) spread[key] = urlObject[key];
		if (spread.hostname.startsWith("[")) spread.hostname = spread.hostname.slice(1, -1);
		if (spread.port !== "") spread.port = Number(spread.port);
		spread.path = spread.search ? spread.pathname + spread.search : spread.pathname;
		return spread;
	}
	function removeMatchingHeaders(regex, headers) {
		var lastValue;
		for (var header in headers) if (regex.test(header)) {
			lastValue = headers[header];
			delete headers[header];
		}
		return lastValue === null || typeof lastValue === "undefined" ? void 0 : String(lastValue).trim();
	}
	function createErrorType(code, message, baseClass) {
		function CustomError(properties) {
			// istanbul ignore else
			if (isFunction(Error.captureStackTrace)) Error.captureStackTrace(this, this.constructor);
			Object.assign(this, properties || {});
			this.code = code;
			this.message = this.cause ? message + ": " + this.cause.message : message;
		}
		CustomError.prototype = new (baseClass || Error)();
		Object.defineProperties(CustomError.prototype, {
			constructor: {
				value: CustomError,
				enumerable: false
			},
			name: {
				value: "Error [" + code + "]",
				enumerable: false
			}
		});
		return CustomError;
	}
	function destroyRequest(request, error) {
		for (var event of events) request.removeListener(event, eventHandlers[event]);
		request.on("error", noop);
		request.destroy(error);
	}
	function isSubdomain(subdomain, domain) {
		assert(isString(subdomain) && isString(domain));
		var dot = subdomain.length - domain.length - 1;
		return dot > 0 && subdomain[dot] === "." && subdomain.endsWith(domain);
	}
	function isArray(value) {
		return value instanceof Array;
	}
	function isString(value) {
		return typeof value === "string" || value instanceof String;
	}
	function isFunction(value) {
		return typeof value === "function";
	}
	function isBuffer(value) {
		return typeof value === "object" && "length" in value;
	}
	function isURL(value) {
		return URL && value instanceof URL;
	}
	function escapeRegex(regex) {
		return regex.replace(/[\]\\/()*+?.$]/g, "\\$&");
	}
	module.exports = wrap({
		http: http$1,
		https: https$1
	});
	module.exports.wrap = wrap;
}));
//#endregion
//#region node_modules/axios/dist/node/axios.cjs
/*! Axios v1.16.0 Copyright (c) 2026 Matt Zabriskie and contributors */
var require_axios = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var FormData$1 = require_form_data();
	var crypto = __require("crypto");
	var url = __require("url");
	var http = __require("http");
	var https = __require("https");
	var http2 = __require("http2");
	var util = __require("util");
	var path = __require("path");
	var followRedirects = require_follow_redirects();
	var zlib = __require("zlib");
	var stream = __require("stream");
	var events = __require("events");
	/**
	* Create a bound version of a function with a specified `this` context
	*
	* @param {Function} fn - The function to bind
	* @param {*} thisArg - The value to be passed as the `this` parameter
	* @returns {Function} A new function that will call the original function with the specified `this` context
	*/
	function bind(fn, thisArg) {
		return function wrap() {
			return fn.apply(thisArg, arguments);
		};
	}
	const { toString } = Object.prototype;
	const { getPrototypeOf } = Object;
	const { iterator, toStringTag } = Symbol;
	const kindOf = ((cache) => (thing) => {
		const str = toString.call(thing);
		return cache[str] || (cache[str] = str.slice(8, -1).toLowerCase());
	})(Object.create(null));
	const kindOfTest = (type) => {
		type = type.toLowerCase();
		return (thing) => kindOf(thing) === type;
	};
	const typeOfTest = (type) => (thing) => typeof thing === type;
	/**
	* Determine if a value is a non-null object
	*
	* @param {Object} val The value to test
	*
	* @returns {boolean} True if value is an Array, otherwise false
	*/
	const { isArray } = Array;
	/**
	* Determine if a value is undefined
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if the value is undefined, otherwise false
	*/
	const isUndefined = typeOfTest("undefined");
	/**
	* Determine if a value is a Buffer
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a Buffer, otherwise false
	*/
	function isBuffer(val) {
		return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && isFunction$1(val.constructor.isBuffer) && val.constructor.isBuffer(val);
	}
	/**
	* Determine if a value is an ArrayBuffer
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is an ArrayBuffer, otherwise false
	*/
	const isArrayBuffer = kindOfTest("ArrayBuffer");
	/**
	* Determine if a value is a view on an ArrayBuffer
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a view on an ArrayBuffer, otherwise false
	*/
	function isArrayBufferView(val) {
		let result;
		if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView) result = ArrayBuffer.isView(val);
		else result = val && val.buffer && isArrayBuffer(val.buffer);
		return result;
	}
	/**
	* Determine if a value is a String
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a String, otherwise false
	*/
	const isString = typeOfTest("string");
	/**
	* Determine if a value is a Function
	*
	* @param {*} val The value to test
	* @returns {boolean} True if value is a Function, otherwise false
	*/
	const isFunction$1 = typeOfTest("function");
	/**
	* Determine if a value is a Number
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a Number, otherwise false
	*/
	const isNumber = typeOfTest("number");
	/**
	* Determine if a value is an Object
	*
	* @param {*} thing The value to test
	*
	* @returns {boolean} True if value is an Object, otherwise false
	*/
	const isObject = (thing) => thing !== null && typeof thing === "object";
	/**
	* Determine if a value is a Boolean
	*
	* @param {*} thing The value to test
	* @returns {boolean} True if value is a Boolean, otherwise false
	*/
	const isBoolean = (thing) => thing === true || thing === false;
	/**
	* Determine if a value is a plain Object
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a plain Object, otherwise false
	*/
	const isPlainObject = (val) => {
		if (kindOf(val) !== "object") return false;
		const prototype = getPrototypeOf(val);
		return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(toStringTag in val) && !(iterator in val);
	};
	/**
	* Determine if a value is an empty object (safely handles Buffers)
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is an empty object, otherwise false
	*/
	const isEmptyObject = (val) => {
		if (!isObject(val) || isBuffer(val)) return false;
		try {
			return Object.keys(val).length === 0 && Object.getPrototypeOf(val) === Object.prototype;
		} catch (e) {
			return false;
		}
	};
	/**
	* Determine if a value is a Date
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a Date, otherwise false
	*/
	const isDate = kindOfTest("Date");
	/**
	* Determine if a value is a File
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a File, otherwise false
	*/
	const isFile = kindOfTest("File");
	/**
	* Determine if a value is a React Native Blob
	* React Native "blob": an object with a `uri` attribute. Optionally, it can
	* also have a `name` and `type` attribute to specify filename and content type
	*
	* @see https://github.com/facebook/react-native/blob/26684cf3adf4094eb6c405d345a75bf8c7c0bf88/Libraries/Network/FormData.js#L68-L71
	*
	* @param {*} value The value to test
	*
	* @returns {boolean} True if value is a React Native Blob, otherwise false
	*/
	const isReactNativeBlob = (value) => {
		return !!(value && typeof value.uri !== "undefined");
	};
	/**
	* Determine if environment is React Native
	* ReactNative `FormData` has a non-standard `getParts()` method
	*
	* @param {*} formData The formData to test
	*
	* @returns {boolean} True if environment is React Native, otherwise false
	*/
	const isReactNative = (formData) => formData && typeof formData.getParts !== "undefined";
	/**
	* Determine if a value is a Blob
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a Blob, otherwise false
	*/
	const isBlob = kindOfTest("Blob");
	/**
	* Determine if a value is a FileList
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a FileList, otherwise false
	*/
	const isFileList = kindOfTest("FileList");
	/**
	* Determine if a value is a Stream
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a Stream, otherwise false
	*/
	const isStream = (val) => isObject(val) && isFunction$1(val.pipe);
	/**
	* Determine if a value is a FormData
	*
	* @param {*} thing The value to test
	*
	* @returns {boolean} True if value is an FormData, otherwise false
	*/
	function getGlobal() {
		if (typeof globalThis !== "undefined") return globalThis;
		if (typeof self !== "undefined") return self;
		if (typeof window !== "undefined") return window;
		if (typeof global !== "undefined") return global;
		return {};
	}
	const G = getGlobal();
	const FormDataCtor = typeof G.FormData !== "undefined" ? G.FormData : void 0;
	const isFormData = (thing) => {
		if (!thing) return false;
		if (FormDataCtor && thing instanceof FormDataCtor) return true;
		const proto = getPrototypeOf(thing);
		if (!proto || proto === Object.prototype) return false;
		if (!isFunction$1(thing.append)) return false;
		const kind = kindOf(thing);
		return kind === "formdata" || kind === "object" && isFunction$1(thing.toString) && thing.toString() === "[object FormData]";
	};
	/**
	* Determine if a value is a URLSearchParams object
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a URLSearchParams object, otherwise false
	*/
	const isURLSearchParams = kindOfTest("URLSearchParams");
	const [isReadableStream, isRequest, isResponse, isHeaders] = [
		"ReadableStream",
		"Request",
		"Response",
		"Headers"
	].map(kindOfTest);
	/**
	* Trim excess whitespace off the beginning and end of a string
	*
	* @param {String} str The String to trim
	*
	* @returns {String} The String freed of excess whitespace
	*/
	const trim = (str) => {
		return str.trim ? str.trim() : str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
	};
	/**
	* Iterate over an Array or an Object invoking a function for each item.
	*
	* If `obj` is an Array callback will be called passing
	* the value, index, and complete array for each item.
	*
	* If 'obj' is an Object callback will be called passing
	* the value, key, and complete object for each property.
	*
	* @param {Object|Array<unknown>} obj The object to iterate
	* @param {Function} fn The callback to invoke for each item
	*
	* @param {Object} [options]
	* @param {Boolean} [options.allOwnKeys = false]
	* @returns {any}
	*/
	function forEach(obj, fn, { allOwnKeys = false } = {}) {
		if (obj === null || typeof obj === "undefined") return;
		let i;
		let l;
		if (typeof obj !== "object") obj = [obj];
		if (isArray(obj)) for (i = 0, l = obj.length; i < l; i++) fn.call(null, obj[i], i, obj);
		else {
			if (isBuffer(obj)) return;
			const keys = allOwnKeys ? Object.getOwnPropertyNames(obj) : Object.keys(obj);
			const len = keys.length;
			let key;
			for (i = 0; i < len; i++) {
				key = keys[i];
				fn.call(null, obj[key], key, obj);
			}
		}
	}
	/**
	* Finds a key in an object, case-insensitive, returning the actual key name.
	* Returns null if the object is a Buffer or if no match is found.
	*
	* @param {Object} obj - The object to search.
	* @param {string} key - The key to find (case-insensitive).
	* @returns {?string} The actual key name if found, otherwise null.
	*/
	function findKey(obj, key) {
		if (isBuffer(obj)) return null;
		key = key.toLowerCase();
		const keys = Object.keys(obj);
		let i = keys.length;
		let _key;
		while (i-- > 0) {
			_key = keys[i];
			if (key === _key.toLowerCase()) return _key;
		}
		return null;
	}
	const _global = (() => {
		if (typeof globalThis !== "undefined") return globalThis;
		return typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : global;
	})();
	const isContextDefined = (context) => !isUndefined(context) && context !== _global;
	/**
	* Accepts varargs expecting each argument to be an object, then
	* immutably merges the properties of each object and returns result.
	*
	* When multiple objects contain the same key the later object in
	* the arguments list will take precedence.
	*
	* Example:
	*
	* ```js
	* const result = merge({foo: 123}, {foo: 456});
	* console.log(result.foo); // outputs 456
	* ```
	*
	* @param {Object} obj1 Object to merge
	*
	* @returns {Object} Result of all merge properties
	*/
	function merge(...objs) {
		const { caseless, skipUndefined } = isContextDefined(this) && this || {};
		const result = {};
		const assignValue = (val, key) => {
			if (key === "__proto__" || key === "constructor" || key === "prototype") return;
			const targetKey = caseless && findKey(result, key) || key;
			const existing = hasOwnProperty(result, targetKey) ? result[targetKey] : void 0;
			if (isPlainObject(existing) && isPlainObject(val)) result[targetKey] = merge(existing, val);
			else if (isPlainObject(val)) result[targetKey] = merge({}, val);
			else if (isArray(val)) result[targetKey] = val.slice();
			else if (!skipUndefined || !isUndefined(val)) result[targetKey] = val;
		};
		for (let i = 0, l = objs.length; i < l; i++) objs[i] && forEach(objs[i], assignValue);
		return result;
	}
	/**
	* Extends object a by mutably adding to it the properties of object b.
	*
	* @param {Object} a The object to be extended
	* @param {Object} b The object to copy properties from
	* @param {Object} thisArg The object to bind function to
	*
	* @param {Object} [options]
	* @param {Boolean} [options.allOwnKeys]
	* @returns {Object} The resulting value of object a
	*/
	const extend = (a, b, thisArg, { allOwnKeys } = {}) => {
		forEach(b, (val, key) => {
			if (thisArg && isFunction$1(val)) Object.defineProperty(a, key, {
				__proto__: null,
				value: bind(val, thisArg),
				writable: true,
				enumerable: true,
				configurable: true
			});
			else Object.defineProperty(a, key, {
				__proto__: null,
				value: val,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}, { allOwnKeys });
		return a;
	};
	/**
	* Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
	*
	* @param {string} content with BOM
	*
	* @returns {string} content value without BOM
	*/
	const stripBOM = (content) => {
		if (content.charCodeAt(0) === 65279) content = content.slice(1);
		return content;
	};
	/**
	* Inherit the prototype methods from one constructor into another
	* @param {function} constructor
	* @param {function} superConstructor
	* @param {object} [props]
	* @param {object} [descriptors]
	*
	* @returns {void}
	*/
	const inherits = (constructor, superConstructor, props, descriptors) => {
		constructor.prototype = Object.create(superConstructor.prototype, descriptors);
		Object.defineProperty(constructor.prototype, "constructor", {
			__proto__: null,
			value: constructor,
			writable: true,
			enumerable: false,
			configurable: true
		});
		Object.defineProperty(constructor, "super", {
			__proto__: null,
			value: superConstructor.prototype
		});
		props && Object.assign(constructor.prototype, props);
	};
	/**
	* Resolve object with deep prototype chain to a flat object
	* @param {Object} sourceObj source object
	* @param {Object} [destObj]
	* @param {Function|Boolean} [filter]
	* @param {Function} [propFilter]
	*
	* @returns {Object}
	*/
	const toFlatObject = (sourceObj, destObj, filter, propFilter) => {
		let props;
		let i;
		let prop;
		const merged = {};
		destObj = destObj || {};
		if (sourceObj == null) return destObj;
		do {
			props = Object.getOwnPropertyNames(sourceObj);
			i = props.length;
			while (i-- > 0) {
				prop = props[i];
				if ((!propFilter || propFilter(prop, sourceObj, destObj)) && !merged[prop]) {
					destObj[prop] = sourceObj[prop];
					merged[prop] = true;
				}
			}
			sourceObj = filter !== false && getPrototypeOf(sourceObj);
		} while (sourceObj && (!filter || filter(sourceObj, destObj)) && sourceObj !== Object.prototype);
		return destObj;
	};
	/**
	* Determines whether a string ends with the characters of a specified string
	*
	* @param {String} str
	* @param {String} searchString
	* @param {Number} [position= 0]
	*
	* @returns {boolean}
	*/
	const endsWith = (str, searchString, position) => {
		str = String(str);
		if (position === void 0 || position > str.length) position = str.length;
		position -= searchString.length;
		const lastIndex = str.indexOf(searchString, position);
		return lastIndex !== -1 && lastIndex === position;
	};
	/**
	* Returns new array from array like object or null if failed
	*
	* @param {*} [thing]
	*
	* @returns {?Array}
	*/
	const toArray = (thing) => {
		if (!thing) return null;
		if (isArray(thing)) return thing;
		let i = thing.length;
		if (!isNumber(i)) return null;
		const arr = new Array(i);
		while (i-- > 0) arr[i] = thing[i];
		return arr;
	};
	/**
	* Checking if the Uint8Array exists and if it does, it returns a function that checks if the
	* thing passed in is an instance of Uint8Array
	*
	* @param {TypedArray}
	*
	* @returns {Array}
	*/
	const isTypedArray = ((TypedArray) => {
		return (thing) => {
			return TypedArray && thing instanceof TypedArray;
		};
	})(typeof Uint8Array !== "undefined" && getPrototypeOf(Uint8Array));
	/**
	* For each entry in the object, call the function with the key and value.
	*
	* @param {Object<any, any>} obj - The object to iterate over.
	* @param {Function} fn - The function to call for each entry.
	*
	* @returns {void}
	*/
	const forEachEntry = (obj, fn) => {
		const _iterator = (obj && obj[iterator]).call(obj);
		let result;
		while ((result = _iterator.next()) && !result.done) {
			const pair = result.value;
			fn.call(obj, pair[0], pair[1]);
		}
	};
	/**
	* It takes a regular expression and a string, and returns an array of all the matches
	*
	* @param {string} regExp - The regular expression to match against.
	* @param {string} str - The string to search.
	*
	* @returns {Array<boolean>}
	*/
	const matchAll = (regExp, str) => {
		let matches;
		const arr = [];
		while ((matches = regExp.exec(str)) !== null) arr.push(matches);
		return arr;
	};
	const isHTMLForm = kindOfTest("HTMLFormElement");
	const toCamelCase = (str) => {
		return str.toLowerCase().replace(/[-_\s]([a-z\d])(\w*)/g, function replacer(m, p1, p2) {
			return p1.toUpperCase() + p2;
		});
	};
	const hasOwnProperty = (({ hasOwnProperty }) => (obj, prop) => hasOwnProperty.call(obj, prop))(Object.prototype);
	/**
	* Determine if a value is a RegExp object
	*
	* @param {*} val The value to test
	*
	* @returns {boolean} True if value is a RegExp object, otherwise false
	*/
	const isRegExp = kindOfTest("RegExp");
	const reduceDescriptors = (obj, reducer) => {
		const descriptors = Object.getOwnPropertyDescriptors(obj);
		const reducedDescriptors = {};
		forEach(descriptors, (descriptor, name) => {
			let ret;
			if ((ret = reducer(descriptor, name, obj)) !== false) reducedDescriptors[name] = ret || descriptor;
		});
		Object.defineProperties(obj, reducedDescriptors);
	};
	/**
	* Makes all methods read-only
	* @param {Object} obj
	*/
	const freezeMethods = (obj) => {
		reduceDescriptors(obj, (descriptor, name) => {
			if (isFunction$1(obj) && [
				"arguments",
				"caller",
				"callee"
			].includes(name)) return false;
			const value = obj[name];
			if (!isFunction$1(value)) return;
			descriptor.enumerable = false;
			if ("writable" in descriptor) {
				descriptor.writable = false;
				return;
			}
			if (!descriptor.set) descriptor.set = () => {
				throw Error("Can not rewrite read-only method '" + name + "'");
			};
		});
	};
	/**
	* Converts an array or a delimited string into an object set with values as keys and true as values.
	* Useful for fast membership checks.
	*
	* @param {Array|string} arrayOrString - The array or string to convert.
	* @param {string} delimiter - The delimiter to use if input is a string.
	* @returns {Object} An object with keys from the array or string, values set to true.
	*/
	const toObjectSet = (arrayOrString, delimiter) => {
		const obj = {};
		const define = (arr) => {
			arr.forEach((value) => {
				obj[value] = true;
			});
		};
		isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
		return obj;
	};
	const noop = () => {};
	const toFiniteNumber = (value, defaultValue) => {
		return value != null && Number.isFinite(value = +value) ? value : defaultValue;
	};
	/**
	* If the thing is a FormData object, return true, otherwise return false.
	*
	* @param {unknown} thing - The thing to check.
	*
	* @returns {boolean}
	*/
	function isSpecCompliantForm(thing) {
		return !!(thing && isFunction$1(thing.append) && thing[toStringTag] === "FormData" && thing[iterator]);
	}
	/**
	* Recursively converts an object to a JSON-compatible object, handling circular references and Buffers.
	*
	* @param {Object} obj - The object to convert.
	* @returns {Object} The JSON-compatible object.
	*/
	const toJSONObject = (obj) => {
		const stack = new Array(10);
		const visit = (source, i) => {
			if (isObject(source)) {
				if (stack.indexOf(source) >= 0) return;
				if (isBuffer(source)) return source;
				if (!("toJSON" in source)) {
					stack[i] = source;
					const target = isArray(source) ? [] : {};
					forEach(source, (value, key) => {
						const reducedValue = visit(value, i + 1);
						!isUndefined(reducedValue) && (target[key] = reducedValue);
					});
					stack[i] = void 0;
					return target;
				}
			}
			return source;
		};
		return visit(obj, 0);
	};
	/**
	* Determines if a value is an async function.
	*
	* @param {*} thing - The value to test.
	* @returns {boolean} True if value is an async function, otherwise false.
	*/
	const isAsyncFn = kindOfTest("AsyncFunction");
	/**
	* Determines if a value is thenable (has then and catch methods).
	*
	* @param {*} thing - The value to test.
	* @returns {boolean} True if value is thenable, otherwise false.
	*/
	const isThenable = (thing) => thing && (isObject(thing) || isFunction$1(thing)) && isFunction$1(thing.then) && isFunction$1(thing.catch);
	/**
	* Provides a cross-platform setImmediate implementation.
	* Uses native setImmediate if available, otherwise falls back to postMessage or setTimeout.
	*
	* @param {boolean} setImmediateSupported - Whether setImmediate is supported.
	* @param {boolean} postMessageSupported - Whether postMessage is supported.
	* @returns {Function} A function to schedule a callback asynchronously.
	*/
	const _setImmediate = ((setImmediateSupported, postMessageSupported) => {
		if (setImmediateSupported) return setImmediate;
		return postMessageSupported ? ((token, callbacks) => {
			_global.addEventListener("message", ({ source, data }) => {
				if (source === _global && data === token) callbacks.length && callbacks.shift()();
			}, false);
			return (cb) => {
				callbacks.push(cb);
				_global.postMessage(token, "*");
			};
		})(`axios@${Math.random()}`, []) : (cb) => setTimeout(cb);
	})(typeof setImmediate === "function", isFunction$1(_global.postMessage));
	/**
	* Schedules a microtask or asynchronous callback as soon as possible.
	* Uses queueMicrotask if available, otherwise falls back to process.nextTick or _setImmediate.
	*
	* @type {Function}
	*/
	const asap = typeof queueMicrotask !== "undefined" ? queueMicrotask.bind(_global) : typeof process !== "undefined" && process.nextTick || _setImmediate;
	const isIterable = (thing) => thing != null && isFunction$1(thing[iterator]);
	var utils$1 = {
		isArray,
		isArrayBuffer,
		isBuffer,
		isFormData,
		isArrayBufferView,
		isString,
		isNumber,
		isBoolean,
		isObject,
		isPlainObject,
		isEmptyObject,
		isReadableStream,
		isRequest,
		isResponse,
		isHeaders,
		isUndefined,
		isDate,
		isFile,
		isReactNativeBlob,
		isReactNative,
		isBlob,
		isRegExp,
		isFunction: isFunction$1,
		isStream,
		isURLSearchParams,
		isTypedArray,
		isFileList,
		forEach,
		merge,
		extend,
		trim,
		stripBOM,
		inherits,
		toFlatObject,
		kindOf,
		kindOfTest,
		endsWith,
		toArray,
		forEachEntry,
		matchAll,
		isHTMLForm,
		hasOwnProperty,
		hasOwnProp: hasOwnProperty,
		reduceDescriptors,
		freezeMethods,
		toObjectSet,
		toCamelCase,
		noop,
		toFiniteNumber,
		findKey,
		global: _global,
		isContextDefined,
		isSpecCompliantForm,
		toJSONObject,
		isAsyncFn,
		isThenable,
		setImmediate: _setImmediate,
		asap,
		isIterable
	};
	const ignoreDuplicateOf = utils$1.toObjectSet([
		"age",
		"authorization",
		"content-length",
		"content-type",
		"etag",
		"expires",
		"from",
		"host",
		"if-modified-since",
		"if-unmodified-since",
		"last-modified",
		"location",
		"max-forwards",
		"proxy-authorization",
		"referer",
		"retry-after",
		"user-agent"
	]);
	/**
	* Parse headers into an object
	*
	* ```
	* Date: Wed, 27 Aug 2014 08:58:49 GMT
	* Content-Type: application/json
	* Connection: keep-alive
	* Transfer-Encoding: chunked
	* ```
	*
	* @param {String} rawHeaders Headers needing to be parsed
	*
	* @returns {Object} Headers parsed into an object
	*/
	var parseHeaders = (rawHeaders) => {
		const parsed = {};
		let key;
		let val;
		let i;
		rawHeaders && rawHeaders.split("\n").forEach(function parser(line) {
			i = line.indexOf(":");
			key = line.substring(0, i).trim().toLowerCase();
			val = line.substring(i + 1).trim();
			if (!key || parsed[key] && ignoreDuplicateOf[key]) return;
			if (key === "set-cookie") if (parsed[key]) parsed[key].push(val);
			else parsed[key] = [val];
			else parsed[key] = parsed[key] ? parsed[key] + ", " + val : val;
		});
		return parsed;
	};
	const $internals = Symbol("internals");
	const INVALID_HEADER_VALUE_CHARS_RE = /[^\x09\x20-\x7E\x80-\xFF]/g;
	function trimSPorHTAB(str) {
		let start = 0;
		let end = str.length;
		while (start < end) {
			const code = str.charCodeAt(start);
			if (code !== 9 && code !== 32) break;
			start += 1;
		}
		while (end > start) {
			const code = str.charCodeAt(end - 1);
			if (code !== 9 && code !== 32) break;
			end -= 1;
		}
		return start === 0 && end === str.length ? str : str.slice(start, end);
	}
	function normalizeHeader(header) {
		return header && String(header).trim().toLowerCase();
	}
	function sanitizeHeaderValue(str) {
		return trimSPorHTAB(str.replace(INVALID_HEADER_VALUE_CHARS_RE, ""));
	}
	function normalizeValue(value) {
		if (value === false || value == null) return value;
		return utils$1.isArray(value) ? value.map(normalizeValue) : sanitizeHeaderValue(String(value));
	}
	function parseTokens(str) {
		const tokens = Object.create(null);
		const tokensRE = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
		let match;
		while (match = tokensRE.exec(str)) tokens[match[1]] = match[2];
		return tokens;
	}
	const isValidHeaderName = (str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str.trim());
	function matchHeaderValue(context, value, header, filter, isHeaderNameFilter) {
		if (utils$1.isFunction(filter)) return filter.call(this, value, header);
		if (isHeaderNameFilter) value = header;
		if (!utils$1.isString(value)) return;
		if (utils$1.isString(filter)) return value.indexOf(filter) !== -1;
		if (utils$1.isRegExp(filter)) return filter.test(value);
	}
	function formatHeader(header) {
		return header.trim().toLowerCase().replace(/([a-z\d])(\w*)/g, (w, char, str) => {
			return char.toUpperCase() + str;
		});
	}
	function buildAccessors(obj, header) {
		const accessorName = utils$1.toCamelCase(" " + header);
		[
			"get",
			"set",
			"has"
		].forEach((methodName) => {
			Object.defineProperty(obj, methodName + accessorName, {
				__proto__: null,
				value: function(arg1, arg2, arg3) {
					return this[methodName].call(this, header, arg1, arg2, arg3);
				},
				configurable: true
			});
		});
	}
	var AxiosHeaders = class {
		constructor(headers) {
			headers && this.set(headers);
		}
		set(header, valueOrRewrite, rewrite) {
			const self = this;
			function setHeader(_value, _header, _rewrite) {
				const lHeader = normalizeHeader(_header);
				if (!lHeader) throw new Error("header name must be a non-empty string");
				const key = utils$1.findKey(self, lHeader);
				if (!key || self[key] === void 0 || _rewrite === true || _rewrite === void 0 && self[key] !== false) self[key || _header] = normalizeValue(_value);
			}
			const setHeaders = (headers, _rewrite) => utils$1.forEach(headers, (_value, _header) => setHeader(_value, _header, _rewrite));
			if (utils$1.isPlainObject(header) || header instanceof this.constructor) setHeaders(header, valueOrRewrite);
			else if (utils$1.isString(header) && (header = header.trim()) && !isValidHeaderName(header)) setHeaders(parseHeaders(header), valueOrRewrite);
			else if (utils$1.isObject(header) && utils$1.isIterable(header)) {
				let obj = {}, dest, key;
				for (const entry of header) {
					if (!utils$1.isArray(entry)) throw TypeError("Object iterator must return a key-value pair");
					obj[key = entry[0]] = (dest = obj[key]) ? utils$1.isArray(dest) ? [...dest, entry[1]] : [dest, entry[1]] : entry[1];
				}
				setHeaders(obj, valueOrRewrite);
			} else header != null && setHeader(valueOrRewrite, header, rewrite);
			return this;
		}
		get(header, parser) {
			header = normalizeHeader(header);
			if (header) {
				const key = utils$1.findKey(this, header);
				if (key) {
					const value = this[key];
					if (!parser) return value;
					if (parser === true) return parseTokens(value);
					if (utils$1.isFunction(parser)) return parser.call(this, value, key);
					if (utils$1.isRegExp(parser)) return parser.exec(value);
					throw new TypeError("parser must be boolean|regexp|function");
				}
			}
		}
		has(header, matcher) {
			header = normalizeHeader(header);
			if (header) {
				const key = utils$1.findKey(this, header);
				return !!(key && this[key] !== void 0 && (!matcher || matchHeaderValue(this, this[key], key, matcher)));
			}
			return false;
		}
		delete(header, matcher) {
			const self = this;
			let deleted = false;
			function deleteHeader(_header) {
				_header = normalizeHeader(_header);
				if (_header) {
					const key = utils$1.findKey(self, _header);
					if (key && (!matcher || matchHeaderValue(self, self[key], key, matcher))) {
						delete self[key];
						deleted = true;
					}
				}
			}
			if (utils$1.isArray(header)) header.forEach(deleteHeader);
			else deleteHeader(header);
			return deleted;
		}
		clear(matcher) {
			const keys = Object.keys(this);
			let i = keys.length;
			let deleted = false;
			while (i--) {
				const key = keys[i];
				if (!matcher || matchHeaderValue(this, this[key], key, matcher, true)) {
					delete this[key];
					deleted = true;
				}
			}
			return deleted;
		}
		normalize(format) {
			const self = this;
			const headers = {};
			utils$1.forEach(this, (value, header) => {
				const key = utils$1.findKey(headers, header);
				if (key) {
					self[key] = normalizeValue(value);
					delete self[header];
					return;
				}
				const normalized = format ? formatHeader(header) : String(header).trim();
				if (normalized !== header) delete self[header];
				self[normalized] = normalizeValue(value);
				headers[normalized] = true;
			});
			return this;
		}
		concat(...targets) {
			return this.constructor.concat(this, ...targets);
		}
		toJSON(asStrings) {
			const obj = Object.create(null);
			utils$1.forEach(this, (value, header) => {
				value != null && value !== false && (obj[header] = asStrings && utils$1.isArray(value) ? value.join(", ") : value);
			});
			return obj;
		}
		[Symbol.iterator]() {
			return Object.entries(this.toJSON())[Symbol.iterator]();
		}
		toString() {
			return Object.entries(this.toJSON()).map(([header, value]) => header + ": " + value).join("\n");
		}
		getSetCookie() {
			return this.get("set-cookie") || [];
		}
		get [Symbol.toStringTag]() {
			return "AxiosHeaders";
		}
		static from(thing) {
			return thing instanceof this ? thing : new this(thing);
		}
		static concat(first, ...targets) {
			const computed = new this(first);
			targets.forEach((target) => computed.set(target));
			return computed;
		}
		static accessor(header) {
			const accessors = (this[$internals] = this[$internals] = { accessors: {} }).accessors;
			const prototype = this.prototype;
			function defineAccessor(_header) {
				const lHeader = normalizeHeader(_header);
				if (!accessors[lHeader]) {
					buildAccessors(prototype, _header);
					accessors[lHeader] = true;
				}
			}
			utils$1.isArray(header) ? header.forEach(defineAccessor) : defineAccessor(header);
			return this;
		}
	};
	AxiosHeaders.accessor([
		"Content-Type",
		"Content-Length",
		"Accept",
		"Accept-Encoding",
		"User-Agent",
		"Authorization"
	]);
	utils$1.reduceDescriptors(AxiosHeaders.prototype, ({ value }, key) => {
		let mapped = key[0].toUpperCase() + key.slice(1);
		return {
			get: () => value,
			set(headerValue) {
				this[mapped] = headerValue;
			}
		};
	});
	utils$1.freezeMethods(AxiosHeaders);
	const REDACTED = "[REDACTED ****]";
	function hasOwnOrPrototypeToJSON(source) {
		if (utils$1.hasOwnProp(source, "toJSON")) return true;
		let prototype = Object.getPrototypeOf(source);
		while (prototype && prototype !== Object.prototype) {
			if (utils$1.hasOwnProp(prototype, "toJSON")) return true;
			prototype = Object.getPrototypeOf(prototype);
		}
		return false;
	}
	function redactConfig(config, redactKeys) {
		const lowerKeys = new Set(redactKeys.map((k) => String(k).toLowerCase()));
		const seen = [];
		const visit = (source) => {
			if (source === null || typeof source !== "object") return source;
			if (utils$1.isBuffer(source)) return source;
			if (seen.indexOf(source) !== -1) return void 0;
			if (source instanceof AxiosHeaders) source = source.toJSON();
			seen.push(source);
			let result;
			if (utils$1.isArray(source)) {
				result = [];
				source.forEach((v, i) => {
					const reducedValue = visit(v);
					if (!utils$1.isUndefined(reducedValue)) result[i] = reducedValue;
				});
			} else {
				if (!utils$1.isPlainObject(source) && hasOwnOrPrototypeToJSON(source)) {
					seen.pop();
					return source;
				}
				result = Object.create(null);
				for (const [key, value] of Object.entries(source)) {
					const reducedValue = lowerKeys.has(key.toLowerCase()) ? REDACTED : visit(value);
					if (!utils$1.isUndefined(reducedValue)) result[key] = reducedValue;
				}
			}
			seen.pop();
			return result;
		};
		return visit(config);
	}
	var AxiosError = class AxiosError extends Error {
		static from(error, code, config, request, response, customProps) {
			const axiosError = new AxiosError(error.message, code || error.code, config, request, response);
			axiosError.cause = error;
			axiosError.name = error.name;
			if (error.status != null && axiosError.status == null) axiosError.status = error.status;
			customProps && Object.assign(axiosError, customProps);
			return axiosError;
		}
		/**
		* Create an Error with the specified message, config, error code, request and response.
		*
		* @param {string} message The error message.
		* @param {string} [code] The error code (for example, 'ECONNABORTED').
		* @param {Object} [config] The config.
		* @param {Object} [request] The request.
		* @param {Object} [response] The response.
		*
		* @returns {Error} The created error.
		*/
		constructor(message, code, config, request, response) {
			super(message);
			Object.defineProperty(this, "message", {
				__proto__: null,
				value: message,
				enumerable: true,
				writable: true,
				configurable: true
			});
			this.name = "AxiosError";
			this.isAxiosError = true;
			code && (this.code = code);
			config && (this.config = config);
			request && (this.request = request);
			if (response) {
				this.response = response;
				this.status = response.status;
			}
		}
		toJSON() {
			const config = this.config;
			const redactKeys = config && utils$1.hasOwnProp(config, "redact") ? config.redact : void 0;
			const serializedConfig = utils$1.isArray(redactKeys) && redactKeys.length > 0 ? redactConfig(config, redactKeys) : utils$1.toJSONObject(config);
			return {
				message: this.message,
				name: this.name,
				description: this.description,
				number: this.number,
				fileName: this.fileName,
				lineNumber: this.lineNumber,
				columnNumber: this.columnNumber,
				stack: this.stack,
				config: serializedConfig,
				code: this.code,
				status: this.status
			};
		}
	};
	AxiosError.ERR_BAD_OPTION_VALUE = "ERR_BAD_OPTION_VALUE";
	AxiosError.ERR_BAD_OPTION = "ERR_BAD_OPTION";
	AxiosError.ECONNABORTED = "ECONNABORTED";
	AxiosError.ETIMEDOUT = "ETIMEDOUT";
	AxiosError.ECONNREFUSED = "ECONNREFUSED";
	AxiosError.ERR_NETWORK = "ERR_NETWORK";
	AxiosError.ERR_FR_TOO_MANY_REDIRECTS = "ERR_FR_TOO_MANY_REDIRECTS";
	AxiosError.ERR_DEPRECATED = "ERR_DEPRECATED";
	AxiosError.ERR_BAD_RESPONSE = "ERR_BAD_RESPONSE";
	AxiosError.ERR_BAD_REQUEST = "ERR_BAD_REQUEST";
	AxiosError.ERR_CANCELED = "ERR_CANCELED";
	AxiosError.ERR_NOT_SUPPORT = "ERR_NOT_SUPPORT";
	AxiosError.ERR_INVALID_URL = "ERR_INVALID_URL";
	AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED = "ERR_FORM_DATA_DEPTH_EXCEEDED";
	/**
	* Determines if the given thing is a array or js object.
	*
	* @param {string} thing - The object or array to be visited.
	*
	* @returns {boolean}
	*/
	function isVisitable(thing) {
		return utils$1.isPlainObject(thing) || utils$1.isArray(thing);
	}
	/**
	* It removes the brackets from the end of a string
	*
	* @param {string} key - The key of the parameter.
	*
	* @returns {string} the key without the brackets.
	*/
	function removeBrackets(key) {
		return utils$1.endsWith(key, "[]") ? key.slice(0, -2) : key;
	}
	/**
	* It takes a path, a key, and a boolean, and returns a string
	*
	* @param {string} path - The path to the current key.
	* @param {string} key - The key of the current object being iterated over.
	* @param {string} dots - If true, the key will be rendered with dots instead of brackets.
	*
	* @returns {string} The path to the current key.
	*/
	function renderKey(path, key, dots) {
		if (!path) return key;
		return path.concat(key).map(function each(token, i) {
			token = removeBrackets(token);
			return !dots && i ? "[" + token + "]" : token;
		}).join(dots ? "." : "");
	}
	/**
	* If the array is an array and none of its elements are visitable, then it's a flat array.
	*
	* @param {Array<any>} arr - The array to check
	*
	* @returns {boolean}
	*/
	function isFlatArray(arr) {
		return utils$1.isArray(arr) && !arr.some(isVisitable);
	}
	const predicates = utils$1.toFlatObject(utils$1, {}, null, function filter(prop) {
		return /^is[A-Z]/.test(prop);
	});
	/**
	* Convert a data object to FormData
	*
	* @param {Object} obj
	* @param {?Object} [formData]
	* @param {?Object} [options]
	* @param {Function} [options.visitor]
	* @param {Boolean} [options.metaTokens = true]
	* @param {Boolean} [options.dots = false]
	* @param {?Boolean} [options.indexes = false]
	*
	* @returns {Object}
	**/
	/**
	* It converts an object into a FormData object
	*
	* @param {Object<any, any>} obj - The object to convert to form data.
	* @param {string} formData - The FormData object to append to.
	* @param {Object<string, any>} options
	*
	* @returns
	*/
	function toFormData(obj, formData, options) {
		if (!utils$1.isObject(obj)) throw new TypeError("target must be an object");
		formData = formData || new (FormData$1 || FormData)();
		options = utils$1.toFlatObject(options, {
			metaTokens: true,
			dots: false,
			indexes: false
		}, false, function defined(option, source) {
			return !utils$1.isUndefined(source[option]);
		});
		const metaTokens = options.metaTokens;
		const visitor = options.visitor || defaultVisitor;
		const dots = options.dots;
		const indexes = options.indexes;
		const _Blob = options.Blob || typeof Blob !== "undefined" && Blob;
		const maxDepth = options.maxDepth === void 0 ? 100 : options.maxDepth;
		const useBlob = _Blob && utils$1.isSpecCompliantForm(formData);
		if (!utils$1.isFunction(visitor)) throw new TypeError("visitor must be a function");
		function convertValue(value) {
			if (value === null) return "";
			if (utils$1.isDate(value)) return value.toISOString();
			if (utils$1.isBoolean(value)) return value.toString();
			if (!useBlob && utils$1.isBlob(value)) throw new AxiosError("Blob is not supported. Use a Buffer instead.");
			if (utils$1.isArrayBuffer(value) || utils$1.isTypedArray(value)) return useBlob && typeof Blob === "function" ? new Blob([value]) : Buffer.from(value);
			return value;
		}
		/**
		* Default visitor.
		*
		* @param {*} value
		* @param {String|Number} key
		* @param {Array<String|Number>} path
		* @this {FormData}
		*
		* @returns {boolean} return true to visit the each prop of the value recursively
		*/
		function defaultVisitor(value, key, path) {
			let arr = value;
			if (utils$1.isReactNative(formData) && utils$1.isReactNativeBlob(value)) {
				formData.append(renderKey(path, key, dots), convertValue(value));
				return false;
			}
			if (value && !path && typeof value === "object") {
				if (utils$1.endsWith(key, "{}")) {
					key = metaTokens ? key : key.slice(0, -2);
					value = JSON.stringify(value);
				} else if (utils$1.isArray(value) && isFlatArray(value) || (utils$1.isFileList(value) || utils$1.endsWith(key, "[]")) && (arr = utils$1.toArray(value))) {
					key = removeBrackets(key);
					arr.forEach(function each(el, index) {
						!(utils$1.isUndefined(el) || el === null) && formData.append(indexes === true ? renderKey([key], index, dots) : indexes === null ? key : key + "[]", convertValue(el));
					});
					return false;
				}
			}
			if (isVisitable(value)) return true;
			formData.append(renderKey(path, key, dots), convertValue(value));
			return false;
		}
		const stack = [];
		const exposedHelpers = Object.assign(predicates, {
			defaultVisitor,
			convertValue,
			isVisitable
		});
		function build(value, path, depth = 0) {
			if (utils$1.isUndefined(value)) return;
			if (depth > maxDepth) throw new AxiosError("Object is too deeply nested (" + depth + " levels). Max depth: " + maxDepth, AxiosError.ERR_FORM_DATA_DEPTH_EXCEEDED);
			if (stack.indexOf(value) !== -1) throw Error("Circular reference detected in " + path.join("."));
			stack.push(value);
			utils$1.forEach(value, function each(el, key) {
				if ((!(utils$1.isUndefined(el) || el === null) && visitor.call(formData, el, utils$1.isString(key) ? key.trim() : key, path, exposedHelpers)) === true) build(el, path ? path.concat(key) : [key], depth + 1);
			});
			stack.pop();
		}
		if (!utils$1.isObject(obj)) throw new TypeError("data must be an object");
		build(obj);
		return formData;
	}
	/**
	* It encodes a string by replacing all characters that are not in the unreserved set with
	* their percent-encoded equivalents
	*
	* @param {string} str - The string to encode.
	*
	* @returns {string} The encoded string.
	*/
	function encode$1(str) {
		const charMap = {
			"!": "%21",
			"'": "%27",
			"(": "%28",
			")": "%29",
			"~": "%7E",
			"%20": "+"
		};
		return encodeURIComponent(str).replace(/[!'()~]|%20/g, function replacer(match) {
			return charMap[match];
		});
	}
	/**
	* It takes a params object and converts it to a FormData object
	*
	* @param {Object<string, any>} params - The parameters to be converted to a FormData object.
	* @param {Object<string, any>} options - The options object passed to the Axios constructor.
	*
	* @returns {void}
	*/
	function AxiosURLSearchParams(params, options) {
		this._pairs = [];
		params && toFormData(params, this, options);
	}
	const prototype = AxiosURLSearchParams.prototype;
	prototype.append = function append(name, value) {
		this._pairs.push([name, value]);
	};
	prototype.toString = function toString(encoder) {
		const _encode = encoder ? function(value) {
			return encoder.call(this, value, encode$1);
		} : encode$1;
		return this._pairs.map(function each(pair) {
			return _encode(pair[0]) + "=" + _encode(pair[1]);
		}, "").join("&");
	};
	/**
	* It replaces URL-encoded forms of `:`, `$`, `,`, and spaces with
	* their plain counterparts (`:`, `$`, `,`, `+`).
	*
	* @param {string} val The value to be encoded.
	*
	* @returns {string} The encoded value.
	*/
	function encode(val) {
		return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
	}
	/**
	* Build a URL by appending params to the end
	*
	* @param {string} url The base of the url (e.g., http://www.google.com)
	* @param {object} [params] The params to be appended
	* @param {?(object|Function)} options
	*
	* @returns {string} The formatted url
	*/
	function buildURL(url, params, options) {
		if (!params) return url;
		const _encode = options && options.encode || encode;
		const _options = utils$1.isFunction(options) ? { serialize: options } : options;
		const serializeFn = _options && _options.serialize;
		let serializedParams;
		if (serializeFn) serializedParams = serializeFn(params, _options);
		else serializedParams = utils$1.isURLSearchParams(params) ? params.toString() : new AxiosURLSearchParams(params, _options).toString(_encode);
		if (serializedParams) {
			const hashmarkIndex = url.indexOf("#");
			if (hashmarkIndex !== -1) url = url.slice(0, hashmarkIndex);
			url += (url.indexOf("?") === -1 ? "?" : "&") + serializedParams;
		}
		return url;
	}
	var InterceptorManager = class {
		constructor() {
			this.handlers = [];
		}
		/**
		* Add a new interceptor to the stack
		*
		* @param {Function} fulfilled The function to handle `then` for a `Promise`
		* @param {Function} rejected The function to handle `reject` for a `Promise`
		* @param {Object} options The options for the interceptor, synchronous and runWhen
		*
		* @return {Number} An ID used to remove interceptor later
		*/
		use(fulfilled, rejected, options) {
			this.handlers.push({
				fulfilled,
				rejected,
				synchronous: options ? options.synchronous : false,
				runWhen: options ? options.runWhen : null
			});
			return this.handlers.length - 1;
		}
		/**
		* Remove an interceptor from the stack
		*
		* @param {Number} id The ID that was returned by `use`
		*
		* @returns {void}
		*/
		eject(id) {
			if (this.handlers[id]) this.handlers[id] = null;
		}
		/**
		* Clear all interceptors from the stack
		*
		* @returns {void}
		*/
		clear() {
			if (this.handlers) this.handlers = [];
		}
		/**
		* Iterate over all the registered interceptors
		*
		* This method is particularly useful for skipping over any
		* interceptors that may have become `null` calling `eject`.
		*
		* @param {Function} fn The function to call for each interceptor
		*
		* @returns {void}
		*/
		forEach(fn) {
			utils$1.forEach(this.handlers, function forEachHandler(h) {
				if (h !== null) fn(h);
			});
		}
	};
	var transitionalDefaults = {
		silentJSONParsing: true,
		forcedJSONParsing: true,
		clarifyTimeoutError: false,
		legacyInterceptorReqResOrdering: true
	};
	var URLSearchParams = url.URLSearchParams;
	const ALPHA = "abcdefghijklmnopqrstuvwxyz";
	const DIGIT = "0123456789";
	const ALPHABET = {
		DIGIT,
		ALPHA,
		ALPHA_DIGIT: ALPHA + ALPHA.toUpperCase() + DIGIT
	};
	const generateString = (size = 16, alphabet = ALPHABET.ALPHA_DIGIT) => {
		let str = "";
		const { length } = alphabet;
		const randomValues = new Uint32Array(size);
		crypto.randomFillSync(randomValues);
		for (let i = 0; i < size; i++) str += alphabet[randomValues[i] % length];
		return str;
	};
	var platform$1 = {
		isNode: true,
		classes: {
			URLSearchParams,
			FormData: FormData$1,
			Blob: typeof Blob !== "undefined" && Blob || null
		},
		ALPHABET,
		generateString,
		protocols: [
			"http",
			"https",
			"file",
			"data"
		]
	};
	const hasBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
	const _navigator = typeof navigator === "object" && navigator || void 0;
	/**
	* Determine if we're running in a standard browser environment
	*
	* This allows axios to run in a web worker, and react-native.
	* Both environments support XMLHttpRequest, but not fully standard globals.
	*
	* web workers:
	*  typeof window -> undefined
	*  typeof document -> undefined
	*
	* react-native:
	*  navigator.product -> 'ReactNative'
	* nativescript
	*  navigator.product -> 'NativeScript' or 'NS'
	*
	* @returns {boolean}
	*/
	const hasStandardBrowserEnv = hasBrowserEnv && (!_navigator || [
		"ReactNative",
		"NativeScript",
		"NS"
	].indexOf(_navigator.product) < 0);
	/**
	* Determine if we're running in a standard browser webWorker environment
	*
	* Although the `isStandardBrowserEnv` method indicates that
	* `allows axios to run in a web worker`, the WebWorker will still be
	* filtered out due to its judgment standard
	* `typeof window !== 'undefined' && typeof document !== 'undefined'`.
	* This leads to a problem when axios post `FormData` in webWorker
	*/
	const hasStandardBrowserWebWorkerEnv = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope && typeof self.importScripts === "function";
	const origin = hasBrowserEnv && window.location.href || "http://localhost";
	var platform = {
		.../* @__PURE__ */ Object.freeze({
			__proto__: null,
			hasBrowserEnv,
			hasStandardBrowserEnv,
			hasStandardBrowserWebWorkerEnv,
			navigator: _navigator,
			origin
		}),
		...platform$1
	};
	function toURLEncodedForm(data, options) {
		return toFormData(data, new platform.classes.URLSearchParams(), {
			visitor: function(value, key, path, helpers) {
				if (platform.isNode && utils$1.isBuffer(value)) {
					this.append(key, value.toString("base64"));
					return false;
				}
				return helpers.defaultVisitor.apply(this, arguments);
			},
			...options
		});
	}
	/**
	* It takes a string like `foo[x][y][z]` and returns an array like `['foo', 'x', 'y', 'z']
	*
	* @param {string} name - The name of the property to get.
	*
	* @returns An array of strings.
	*/
	function parsePropPath(name) {
		return utils$1.matchAll(/\w+|\[(\w*)]/g, name).map((match) => {
			return match[0] === "[]" ? "" : match[1] || match[0];
		});
	}
	/**
	* Convert an array to an object.
	*
	* @param {Array<any>} arr - The array to convert to an object.
	*
	* @returns An object with the same keys and values as the array.
	*/
	function arrayToObject(arr) {
		const obj = {};
		const keys = Object.keys(arr);
		let i;
		const len = keys.length;
		let key;
		for (i = 0; i < len; i++) {
			key = keys[i];
			obj[key] = arr[key];
		}
		return obj;
	}
	/**
	* It takes a FormData object and returns a JavaScript object
	*
	* @param {string} formData The FormData object to convert to JSON.
	*
	* @returns {Object<string, any> | null} The converted object.
	*/
	function formDataToJSON(formData) {
		function buildPath(path, value, target, index) {
			let name = path[index++];
			if (name === "__proto__") return true;
			const isNumericKey = Number.isFinite(+name);
			const isLast = index >= path.length;
			name = !name && utils$1.isArray(target) ? target.length : name;
			if (isLast) {
				if (utils$1.hasOwnProp(target, name)) target[name] = utils$1.isArray(target[name]) ? target[name].concat(value) : [target[name], value];
				else target[name] = value;
				return !isNumericKey;
			}
			if (!target[name] || !utils$1.isObject(target[name])) target[name] = [];
			if (buildPath(path, value, target[name], index) && utils$1.isArray(target[name])) target[name] = arrayToObject(target[name]);
			return !isNumericKey;
		}
		if (utils$1.isFormData(formData) && utils$1.isFunction(formData.entries)) {
			const obj = {};
			utils$1.forEachEntry(formData, (name, value) => {
				buildPath(parsePropPath(name), value, obj, 0);
			});
			return obj;
		}
		return null;
	}
	const own = (obj, key) => obj != null && utils$1.hasOwnProp(obj, key) ? obj[key] : void 0;
	/**
	* It takes a string, tries to parse it, and if it fails, it returns the stringified version
	* of the input
	*
	* @param {any} rawValue - The value to be stringified.
	* @param {Function} parser - A function that parses a string into a JavaScript object.
	* @param {Function} encoder - A function that takes a value and returns a string.
	*
	* @returns {string} A stringified version of the rawValue.
	*/
	function stringifySafely(rawValue, parser, encoder) {
		if (utils$1.isString(rawValue)) try {
			(parser || JSON.parse)(rawValue);
			return utils$1.trim(rawValue);
		} catch (e) {
			if (e.name !== "SyntaxError") throw e;
		}
		return (encoder || JSON.stringify)(rawValue);
	}
	const defaults = {
		transitional: transitionalDefaults,
		adapter: [
			"xhr",
			"http",
			"fetch"
		],
		transformRequest: [function transformRequest(data, headers) {
			const contentType = headers.getContentType() || "";
			const hasJSONContentType = contentType.indexOf("application/json") > -1;
			const isObjectPayload = utils$1.isObject(data);
			if (isObjectPayload && utils$1.isHTMLForm(data)) data = new FormData(data);
			if (utils$1.isFormData(data)) return hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data;
			if (utils$1.isArrayBuffer(data) || utils$1.isBuffer(data) || utils$1.isStream(data) || utils$1.isFile(data) || utils$1.isBlob(data) || utils$1.isReadableStream(data)) return data;
			if (utils$1.isArrayBufferView(data)) return data.buffer;
			if (utils$1.isURLSearchParams(data)) {
				headers.setContentType("application/x-www-form-urlencoded;charset=utf-8", false);
				return data.toString();
			}
			let isFileList;
			if (isObjectPayload) {
				const formSerializer = own(this, "formSerializer");
				if (contentType.indexOf("application/x-www-form-urlencoded") > -1) return toURLEncodedForm(data, formSerializer).toString();
				if ((isFileList = utils$1.isFileList(data)) || contentType.indexOf("multipart/form-data") > -1) {
					const env = own(this, "env");
					const _FormData = env && env.FormData;
					return toFormData(isFileList ? { "files[]": data } : data, _FormData && new _FormData(), formSerializer);
				}
			}
			if (isObjectPayload || hasJSONContentType) {
				headers.setContentType("application/json", false);
				return stringifySafely(data);
			}
			return data;
		}],
		transformResponse: [function transformResponse(data) {
			const transitional = own(this, "transitional") || defaults.transitional;
			const forcedJSONParsing = transitional && transitional.forcedJSONParsing;
			const responseType = own(this, "responseType");
			const JSONRequested = responseType === "json";
			if (utils$1.isResponse(data) || utils$1.isReadableStream(data)) return data;
			if (data && utils$1.isString(data) && (forcedJSONParsing && !responseType || JSONRequested)) {
				const strictJSONParsing = !(transitional && transitional.silentJSONParsing) && JSONRequested;
				try {
					return JSON.parse(data, own(this, "parseReviver"));
				} catch (e) {
					if (strictJSONParsing) {
						if (e.name === "SyntaxError") throw AxiosError.from(e, AxiosError.ERR_BAD_RESPONSE, this, null, own(this, "response"));
						throw e;
					}
				}
			}
			return data;
		}],
		/**
		* A timeout in milliseconds to abort a request. If set to 0 (default) a
		* timeout is not created.
		*/
		timeout: 0,
		xsrfCookieName: "XSRF-TOKEN",
		xsrfHeaderName: "X-XSRF-TOKEN",
		maxContentLength: -1,
		maxBodyLength: -1,
		env: {
			FormData: platform.classes.FormData,
			Blob: platform.classes.Blob
		},
		validateStatus: function validateStatus(status) {
			return status >= 200 && status < 300;
		},
		headers: { common: {
			Accept: "application/json, text/plain, */*",
			"Content-Type": void 0
		} }
	};
	utils$1.forEach([
		"delete",
		"get",
		"head",
		"post",
		"put",
		"patch",
		"query"
	], (method) => {
		defaults.headers[method] = {};
	});
	/**
	* Transform the data for a request or a response
	*
	* @param {Array|Function} fns A single function or Array of functions
	* @param {?Object} response The response object
	*
	* @returns {*} The resulting transformed data
	*/
	function transformData(fns, response) {
		const config = this || defaults;
		const context = response || config;
		const headers = AxiosHeaders.from(context.headers);
		let data = context.data;
		utils$1.forEach(fns, function transform(fn) {
			data = fn.call(config, data, headers.normalize(), response ? response.status : void 0);
		});
		headers.normalize();
		return data;
	}
	function isCancel(value) {
		return !!(value && value.__CANCEL__);
	}
	var CanceledError = class extends AxiosError {
		/**
		* A `CanceledError` is an object that is thrown when an operation is canceled.
		*
		* @param {string=} message The message.
		* @param {Object=} config The config.
		* @param {Object=} request The request.
		*
		* @returns {CanceledError} The created error.
		*/
		constructor(message, config, request) {
			super(message == null ? "canceled" : message, AxiosError.ERR_CANCELED, config, request);
			this.name = "CanceledError";
			this.__CANCEL__ = true;
		}
	};
	/**
	* Resolve or reject a Promise based on response status.
	*
	* @param {Function} resolve A function that resolves the promise.
	* @param {Function} reject A function that rejects the promise.
	* @param {object} response The response.
	*
	* @returns {object} The response.
	*/
	function settle(resolve, reject, response) {
		const validateStatus = response.config.validateStatus;
		if (!response.status || !validateStatus || validateStatus(response.status)) resolve(response);
		else reject(new AxiosError("Request failed with status code " + response.status, response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE, response.config, response.request, response));
	}
	/**
	* Determines whether the specified URL is absolute
	*
	* @param {string} url The URL to test
	*
	* @returns {boolean} True if the specified URL is absolute, otherwise false
	*/
	function isAbsoluteURL(url) {
		if (typeof url !== "string") return false;
		return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
	}
	/**
	* Creates a new URL by combining the specified URLs
	*
	* @param {string} baseURL The base URL
	* @param {string} relativeURL The relative URL
	*
	* @returns {string} The combined URL
	*/
	function combineURLs(baseURL, relativeURL) {
		return relativeURL ? baseURL.replace(/\/?\/$/, "") + "/" + relativeURL.replace(/^\/+/, "") : baseURL;
	}
	/**
	* Creates a new URL by combining the baseURL with the requestedURL,
	* only when the requestedURL is not already an absolute URL.
	* If the requestURL is absolute, this function returns the requestedURL untouched.
	*
	* @param {string} baseURL The base URL
	* @param {string} requestedURL Absolute or relative URL to combine
	*
	* @returns {string} The combined full path
	*/
	function buildFullPath(baseURL, requestedURL, allowAbsoluteUrls) {
		let isRelativeUrl = !isAbsoluteURL(requestedURL);
		if (baseURL && (isRelativeUrl || allowAbsoluteUrls === false)) return combineURLs(baseURL, requestedURL);
		return requestedURL;
	}
	var DEFAULT_PORTS$1 = {
		ftp: 21,
		gopher: 70,
		http: 80,
		https: 443,
		ws: 80,
		wss: 443
	};
	function parseUrl(urlString) {
		try {
			return new URL(urlString);
		} catch {
			return null;
		}
	}
	/**
	* @param {string|object|URL} url - The URL as a string or URL instance, or a
	*   compatible object (such as the result from legacy url.parse).
	* @return {string} The URL of the proxy that should handle the request to the
	*  given URL. If no proxy is set, this will be an empty string.
	*/
	function getProxyForUrl(url) {
		var parsedUrl = (typeof url === "string" ? parseUrl(url) : url) || {};
		var proto = parsedUrl.protocol;
		var hostname = parsedUrl.host;
		var port = parsedUrl.port;
		if (typeof hostname !== "string" || !hostname || typeof proto !== "string") return "";
		proto = proto.split(":", 1)[0];
		hostname = hostname.replace(/:\d*$/, "");
		port = parseInt(port) || DEFAULT_PORTS$1[proto] || 0;
		if (!shouldProxy(hostname, port)) return "";
		var proxy = getEnv(proto + "_proxy") || getEnv("all_proxy");
		if (proxy && proxy.indexOf("://") === -1) proxy = proto + "://" + proxy;
		return proxy;
	}
	/**
	* Determines whether a given URL should be proxied.
	*
	* @param {string} hostname - The host name of the URL.
	* @param {number} port - The effective port of the URL.
	* @returns {boolean} Whether the given URL should be proxied.
	* @private
	*/
	function shouldProxy(hostname, port) {
		var NO_PROXY = getEnv("no_proxy").toLowerCase();
		if (!NO_PROXY) return true;
		if (NO_PROXY === "*") return false;
		return NO_PROXY.split(/[,\s]/).every(function(proxy) {
			if (!proxy) return true;
			var parsedProxy = proxy.match(/^(.+):(\d+)$/);
			var parsedProxyHostname = parsedProxy ? parsedProxy[1] : proxy;
			var parsedProxyPort = parsedProxy ? parseInt(parsedProxy[2]) : 0;
			if (parsedProxyPort && parsedProxyPort !== port) return true;
			if (!/^[.*]/.test(parsedProxyHostname)) return hostname !== parsedProxyHostname;
			if (parsedProxyHostname.charAt(0) === "*") parsedProxyHostname = parsedProxyHostname.slice(1);
			return !hostname.endsWith(parsedProxyHostname);
		});
	}
	/**
	* Get the value for an environment variable.
	*
	* @param {string} key - The name of the environment variable.
	* @return {string} The value of the environment variable.
	* @private
	*/
	function getEnv(key) {
		return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
	}
	const VERSION = "1.16.0";
	function parseProtocol(url) {
		const match = /^([-+\w]{1,25}):(?:\/\/)?/.exec(url);
		return match && match[1] || "";
	}
	const DATA_URL_PATTERN = /^(?:([^;]+);)?(?:[^;]+;)?(base64|),([\s\S]*)$/;
	/**
	* Parse data uri to a Buffer or Blob
	*
	* @param {String} uri
	* @param {?Boolean} asBlob
	* @param {?Object} options
	* @param {?Function} options.Blob
	*
	* @returns {Buffer|Blob}
	*/
	function fromDataURI(uri, asBlob, options) {
		const _Blob = options && options.Blob || platform.classes.Blob;
		const protocol = parseProtocol(uri);
		if (asBlob === void 0 && _Blob) asBlob = true;
		if (protocol === "data") {
			uri = protocol.length ? uri.slice(protocol.length + 1) : uri;
			const match = DATA_URL_PATTERN.exec(uri);
			if (!match) throw new AxiosError("Invalid URL", AxiosError.ERR_INVALID_URL);
			const mime = match[1];
			const isBase64 = match[2];
			const body = match[3];
			const buffer = Buffer.from(decodeURIComponent(body), isBase64 ? "base64" : "utf8");
			if (asBlob) {
				if (!_Blob) throw new AxiosError("Blob is not supported", AxiosError.ERR_NOT_SUPPORT);
				return new _Blob([buffer], { type: mime });
			}
			return buffer;
		}
		throw new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_NOT_SUPPORT);
	}
	const kInternals = Symbol("internals");
	var AxiosTransformStream = class extends stream.Transform {
		constructor(options) {
			options = utils$1.toFlatObject(options, {
				maxRate: 0,
				chunkSize: 64 * 1024,
				minChunkSize: 100,
				timeWindow: 500,
				ticksRate: 2,
				samplesCount: 15
			}, null, (prop, source) => {
				return !utils$1.isUndefined(source[prop]);
			});
			super({ readableHighWaterMark: options.chunkSize });
			const internals = this[kInternals] = {
				timeWindow: options.timeWindow,
				chunkSize: options.chunkSize,
				maxRate: options.maxRate,
				minChunkSize: options.minChunkSize,
				bytesSeen: 0,
				isCaptured: false,
				notifiedBytesLoaded: 0,
				ts: Date.now(),
				bytes: 0,
				onReadCallback: null
			};
			this.on("newListener", (event) => {
				if (event === "progress") {
					if (!internals.isCaptured) internals.isCaptured = true;
				}
			});
		}
		_read(size) {
			const internals = this[kInternals];
			if (internals.onReadCallback) internals.onReadCallback();
			return super._read(size);
		}
		_transform(chunk, encoding, callback) {
			const internals = this[kInternals];
			const maxRate = internals.maxRate;
			const readableHighWaterMark = this.readableHighWaterMark;
			const timeWindow = internals.timeWindow;
			const bytesThreshold = maxRate / (1e3 / timeWindow);
			const minChunkSize = internals.minChunkSize !== false ? Math.max(internals.minChunkSize, bytesThreshold * .01) : 0;
			const pushChunk = (_chunk, _callback) => {
				const bytes = Buffer.byteLength(_chunk);
				internals.bytesSeen += bytes;
				internals.bytes += bytes;
				internals.isCaptured && this.emit("progress", internals.bytesSeen);
				if (this.push(_chunk)) process.nextTick(_callback);
				else internals.onReadCallback = () => {
					internals.onReadCallback = null;
					process.nextTick(_callback);
				};
			};
			const transformChunk = (_chunk, _callback) => {
				const chunkSize = Buffer.byteLength(_chunk);
				let chunkRemainder = null;
				let maxChunkSize = readableHighWaterMark;
				let bytesLeft;
				let passed = 0;
				if (maxRate) {
					const now = Date.now();
					if (!internals.ts || (passed = now - internals.ts) >= timeWindow) {
						internals.ts = now;
						bytesLeft = bytesThreshold - internals.bytes;
						internals.bytes = bytesLeft < 0 ? -bytesLeft : 0;
						passed = 0;
					}
					bytesLeft = bytesThreshold - internals.bytes;
				}
				if (maxRate) {
					if (bytesLeft <= 0) return setTimeout(() => {
						_callback(null, _chunk);
					}, timeWindow - passed);
					if (bytesLeft < maxChunkSize) maxChunkSize = bytesLeft;
				}
				if (maxChunkSize && chunkSize > maxChunkSize && chunkSize - maxChunkSize > minChunkSize) {
					chunkRemainder = _chunk.subarray(maxChunkSize);
					_chunk = _chunk.subarray(0, maxChunkSize);
				}
				pushChunk(_chunk, chunkRemainder ? () => {
					process.nextTick(_callback, null, chunkRemainder);
				} : _callback);
			};
			transformChunk(chunk, function transformNextChunk(err, _chunk) {
				if (err) return callback(err);
				if (_chunk) transformChunk(_chunk, transformNextChunk);
				else callback(null);
			});
		}
	};
	const { asyncIterator } = Symbol;
	const readBlob = async function* (blob) {
		if (blob.stream) yield* blob.stream();
		else if (blob.arrayBuffer) yield await blob.arrayBuffer();
		else if (blob[asyncIterator]) yield* blob[asyncIterator]();
		else yield blob;
	};
	const BOUNDARY_ALPHABET = platform.ALPHABET.ALPHA_DIGIT + "-_";
	const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : new util.TextEncoder();
	const CRLF = "\r\n";
	const CRLF_BYTES = textEncoder.encode(CRLF);
	const CRLF_BYTES_COUNT = 2;
	var FormDataPart = class {
		constructor(name, value) {
			const { escapeName } = this.constructor;
			const isStringValue = utils$1.isString(value);
			let headers = `Content-Disposition: form-data; name="${escapeName(name)}"${!isStringValue && value.name ? `; filename="${escapeName(value.name)}"` : ""}${CRLF}`;
			if (isStringValue) value = textEncoder.encode(String(value).replace(/\r?\n|\r\n?/g, CRLF));
			else {
				const safeType = String(value.type || "application/octet-stream").replace(/[\r\n]/g, "");
				headers += `Content-Type: ${safeType}${CRLF}`;
			}
			this.headers = textEncoder.encode(headers + CRLF);
			this.contentLength = isStringValue ? value.byteLength : value.size;
			this.size = this.headers.byteLength + this.contentLength + CRLF_BYTES_COUNT;
			this.name = name;
			this.value = value;
		}
		async *encode() {
			yield this.headers;
			const { value } = this;
			if (utils$1.isTypedArray(value)) yield value;
			else yield* readBlob(value);
			yield CRLF_BYTES;
		}
		static escapeName(name) {
			return String(name).replace(/[\r\n"]/g, (match) => ({
				"\r": "%0D",
				"\n": "%0A",
				"\"": "%22"
			})[match]);
		}
	};
	const formDataToStream = (form, headersHandler, options) => {
		const { tag = "form-data-boundary", size = 25, boundary = tag + "-" + platform.generateString(size, BOUNDARY_ALPHABET) } = options || {};
		if (!utils$1.isFormData(form)) throw TypeError("FormData instance required");
		if (boundary.length < 1 || boundary.length > 70) throw Error("boundary must be 1-70 characters long");
		const boundaryBytes = textEncoder.encode("--" + boundary + CRLF);
		const footerBytes = textEncoder.encode("--" + boundary + "--\r\n");
		let contentLength = footerBytes.byteLength;
		const parts = Array.from(form.entries()).map(([name, value]) => {
			const part = new FormDataPart(name, value);
			contentLength += part.size;
			return part;
		});
		contentLength += boundaryBytes.byteLength * parts.length;
		contentLength = utils$1.toFiniteNumber(contentLength);
		const computedHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
		if (Number.isFinite(contentLength)) computedHeaders["Content-Length"] = contentLength;
		headersHandler && headersHandler(computedHeaders);
		return stream.Readable.from(async function* () {
			for (const part of parts) {
				yield boundaryBytes;
				yield* part.encode();
			}
			yield footerBytes;
		}());
	};
	var ZlibHeaderTransformStream = class extends stream.Transform {
		__transform(chunk, encoding, callback) {
			this.push(chunk);
			callback();
		}
		_transform(chunk, encoding, callback) {
			if (chunk.length !== 0) {
				this._transform = this.__transform;
				if (chunk[0] !== 120) {
					const header = Buffer.alloc(2);
					header[0] = 120;
					header[1] = 156;
					this.push(header, encoding);
				}
			}
			this.__transform(chunk, encoding, callback);
		}
	};
	const callbackify = (fn, reducer) => {
		return utils$1.isAsyncFn(fn) ? function(...args) {
			const cb = args.pop();
			fn.apply(this, args).then((value) => {
				try {
					reducer ? cb(null, ...reducer(value)) : cb(null, value);
				} catch (err) {
					cb(err);
				}
			}, cb);
		} : fn;
	};
	const LOOPBACK_HOSTNAMES = new Set(["localhost"]);
	const isIPv4Loopback = (host) => {
		const parts = host.split(".");
		if (parts.length !== 4) return false;
		if (parts[0] !== "127") return false;
		return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
	};
	const isIPv6Loopback = (host) => {
		if (host === "::1") return true;
		const v4MappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
		if (v4MappedDotted) return isIPv4Loopback(v4MappedDotted[1]);
		const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
		if (v4MappedHex) {
			const high = parseInt(v4MappedHex[1], 16);
			return high >= 32512 && high <= 32767;
		}
		const groups = host.split(":");
		if (groups.length === 8) {
			for (let i = 0; i < 7; i++) if (!/^0+$/.test(groups[i])) return false;
			return /^0*1$/.test(groups[7]);
		}
		return false;
	};
	const isLoopback = (host) => {
		if (!host) return false;
		if (LOOPBACK_HOSTNAMES.has(host)) return true;
		if (isIPv4Loopback(host)) return true;
		return isIPv6Loopback(host);
	};
	const DEFAULT_PORTS = {
		http: 80,
		https: 443,
		ws: 80,
		wss: 443,
		ftp: 21
	};
	const parseNoProxyEntry = (entry) => {
		let entryHost = entry;
		let entryPort = 0;
		if (entryHost.charAt(0) === "[") {
			const bracketIndex = entryHost.indexOf("]");
			if (bracketIndex !== -1) {
				const host = entryHost.slice(1, bracketIndex);
				const rest = entryHost.slice(bracketIndex + 1);
				if (rest.charAt(0) === ":" && /^\d+$/.test(rest.slice(1))) entryPort = Number.parseInt(rest.slice(1), 10);
				return [host, entryPort];
			}
		}
		const firstColon = entryHost.indexOf(":");
		const lastColon = entryHost.lastIndexOf(":");
		if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(entryHost.slice(lastColon + 1))) {
			entryPort = Number.parseInt(entryHost.slice(lastColon + 1), 10);
			entryHost = entryHost.slice(0, lastColon);
		}
		return [entryHost, entryPort];
	};
	const IPV4_MAPPED_DOTTED_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/i;
	const IPV4_MAPPED_HEX_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
	const unmapIPv4MappedIPv6 = (host) => {
		if (typeof host !== "string" || host.indexOf(":") === -1) return host;
		const dotted = host.match(IPV4_MAPPED_DOTTED_RE);
		if (dotted) return dotted[1];
		const hex = host.match(IPV4_MAPPED_HEX_RE);
		if (hex) {
			const high = parseInt(hex[1], 16);
			const low = parseInt(hex[2], 16);
			return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
		}
		return host;
	};
	const normalizeNoProxyHost = (hostname) => {
		if (!hostname) return hostname;
		if (hostname.charAt(0) === "[" && hostname.charAt(hostname.length - 1) === "]") hostname = hostname.slice(1, -1);
		return unmapIPv4MappedIPv6(hostname.replace(/\.+$/, ""));
	};
	function shouldBypassProxy(location) {
		let parsed;
		try {
			parsed = new URL(location);
		} catch (_err) {
			return false;
		}
		const noProxy = (process.env.no_proxy || process.env.NO_PROXY || "").toLowerCase();
		if (!noProxy) return false;
		if (noProxy === "*") return true;
		const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORTS[parsed.protocol.split(":", 1)[0]] || 0;
		const hostname = normalizeNoProxyHost(parsed.hostname.toLowerCase());
		return noProxy.split(/[\s,]+/).some((entry) => {
			if (!entry) return false;
			let [entryHost, entryPort] = parseNoProxyEntry(entry);
			entryHost = normalizeNoProxyHost(entryHost);
			if (!entryHost) return false;
			if (entryPort && entryPort !== port) return false;
			if (entryHost.charAt(0) === "*") entryHost = entryHost.slice(1);
			if (entryHost.charAt(0) === ".") return hostname.endsWith(entryHost);
			return hostname === entryHost || isLoopback(hostname) && isLoopback(entryHost);
		});
	}
	/**
	* Calculate data maxRate
	* @param {Number} [samplesCount= 10]
	* @param {Number} [min= 1000]
	* @returns {Function}
	*/
	function speedometer(samplesCount, min) {
		samplesCount = samplesCount || 10;
		const bytes = new Array(samplesCount);
		const timestamps = new Array(samplesCount);
		let head = 0;
		let tail = 0;
		let firstSampleTS;
		min = min !== void 0 ? min : 1e3;
		return function push(chunkLength) {
			const now = Date.now();
			const startedAt = timestamps[tail];
			if (!firstSampleTS) firstSampleTS = now;
			bytes[head] = chunkLength;
			timestamps[head] = now;
			let i = tail;
			let bytesCount = 0;
			while (i !== head) {
				bytesCount += bytes[i++];
				i = i % samplesCount;
			}
			head = (head + 1) % samplesCount;
			if (head === tail) tail = (tail + 1) % samplesCount;
			if (now - firstSampleTS < min) return;
			const passed = startedAt && now - startedAt;
			return passed ? Math.round(bytesCount * 1e3 / passed) : void 0;
		};
	}
	/**
	* Throttle decorator
	* @param {Function} fn
	* @param {Number} freq
	* @return {Function}
	*/
	function throttle(fn, freq) {
		let timestamp = 0;
		let threshold = 1e3 / freq;
		let lastArgs;
		let timer;
		const invoke = (args, now = Date.now()) => {
			timestamp = now;
			lastArgs = null;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			fn(...args);
		};
		const throttled = (...args) => {
			const now = Date.now();
			const passed = now - timestamp;
			if (passed >= threshold) invoke(args, now);
			else {
				lastArgs = args;
				if (!timer) timer = setTimeout(() => {
					timer = null;
					invoke(lastArgs);
				}, threshold - passed);
			}
		};
		const flush = () => lastArgs && invoke(lastArgs);
		return [throttled, flush];
	}
	const progressEventReducer = (listener, isDownloadStream, freq = 3) => {
		let bytesNotified = 0;
		const _speedometer = speedometer(50, 250);
		return throttle((e) => {
			const rawLoaded = e.loaded;
			const total = e.lengthComputable ? e.total : void 0;
			const loaded = total != null ? Math.min(rawLoaded, total) : rawLoaded;
			const progressBytes = Math.max(0, loaded - bytesNotified);
			const rate = _speedometer(progressBytes);
			bytesNotified = Math.max(bytesNotified, loaded);
			listener({
				loaded,
				total,
				progress: total ? loaded / total : void 0,
				bytes: progressBytes,
				rate: rate ? rate : void 0,
				estimated: rate && total ? (total - loaded) / rate : void 0,
				event: e,
				lengthComputable: total != null,
				[isDownloadStream ? "download" : "upload"]: true
			});
		}, freq);
	};
	const progressEventDecorator = (total, throttled) => {
		const lengthComputable = total != null;
		return [(loaded) => throttled[0]({
			lengthComputable,
			total,
			loaded
		}), throttled[1]];
	};
	const asyncDecorator = (fn) => (...args) => utils$1.asap(() => fn(...args));
	/**
	* Estimate decoded byte length of a data:// URL *without* allocating large buffers.
	* - For base64: compute exact decoded size using length and padding;
	*               handle %XX at the character-count level (no string allocation).
	* - For non-base64: use UTF-8 byteLength of the encoded body as a safe upper bound.
	*
	* @param {string} url
	* @returns {number}
	*/
	function estimateDataURLDecodedBytes(url) {
		if (!url || typeof url !== "string") return 0;
		if (!url.startsWith("data:")) return 0;
		const comma = url.indexOf(",");
		if (comma < 0) return 0;
		const meta = url.slice(5, comma);
		const body = url.slice(comma + 1);
		if (/;base64/i.test(meta)) {
			let effectiveLen = body.length;
			const len = body.length;
			for (let i = 0; i < len; i++) if (body.charCodeAt(i) === 37 && i + 2 < len) {
				const a = body.charCodeAt(i + 1);
				const b = body.charCodeAt(i + 2);
				if ((a >= 48 && a <= 57 || a >= 65 && a <= 70 || a >= 97 && a <= 102) && (b >= 48 && b <= 57 || b >= 65 && b <= 70 || b >= 97 && b <= 102)) {
					effectiveLen -= 2;
					i += 2;
				}
			}
			let pad = 0;
			let idx = len - 1;
			const tailIsPct3D = (j) => j >= 2 && body.charCodeAt(j - 2) === 37 && body.charCodeAt(j - 1) === 51 && (body.charCodeAt(j) === 68 || body.charCodeAt(j) === 100);
			if (idx >= 0) {
				if (body.charCodeAt(idx) === 61) {
					pad++;
					idx--;
				} else if (tailIsPct3D(idx)) {
					pad++;
					idx -= 3;
				}
			}
			if (pad === 1 && idx >= 0) {
				if (body.charCodeAt(idx) === 61) pad++;
				else if (tailIsPct3D(idx)) pad++;
			}
			const bytes = Math.floor(effectiveLen / 4) * 3 - (pad || 0);
			return bytes > 0 ? bytes : 0;
		}
		if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") return Buffer.byteLength(body, "utf8");
		let bytes = 0;
		for (let i = 0, len = body.length; i < len; i++) {
			const c = body.charCodeAt(i);
			if (c < 128) bytes += 1;
			else if (c < 2048) bytes += 2;
			else if (c >= 55296 && c <= 56319 && i + 1 < len) {
				const next = body.charCodeAt(i + 1);
				if (next >= 56320 && next <= 57343) {
					bytes += 4;
					i++;
				} else bytes += 3;
			} else bytes += 3;
		}
		return bytes;
	}
	const zlibOptions = {
		flush: zlib.constants.Z_SYNC_FLUSH,
		finishFlush: zlib.constants.Z_SYNC_FLUSH
	};
	const brotliOptions = {
		flush: zlib.constants.BROTLI_OPERATION_FLUSH,
		finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
	};
	const isBrotliSupported = utils$1.isFunction(zlib.createBrotliDecompress);
	const { http: httpFollow, https: httpsFollow } = followRedirects;
	const isHttps = /https:?/;
	const FORM_DATA_CONTENT_HEADERS$1 = ["content-type", "content-length"];
	function setFormDataHeaders$1(headers, formHeaders, policy) {
		if (policy !== "content-only") {
			headers.set(formHeaders);
			return;
		}
		Object.entries(formHeaders).forEach(([key, val]) => {
			if (FORM_DATA_CONTENT_HEADERS$1.includes(key.toLowerCase())) headers.set(key, val);
		});
	}
	const kAxiosSocketListener = Symbol("axios.http.socketListener");
	const kAxiosCurrentReq = Symbol("axios.http.currentReq");
	const supportedProtocols = platform.protocols.map((protocol) => {
		return protocol + ":";
	});
	const decodeURIComponentSafe = (value) => {
		if (!utils$1.isString(value)) return value;
		try {
			return decodeURIComponent(value);
		} catch (error) {
			return value;
		}
	};
	const flushOnFinish = (stream, [throttled, flush]) => {
		stream.on("end", flush).on("error", flush);
		return throttled;
	};
	var Http2Sessions = class {
		constructor() {
			this.sessions = Object.create(null);
		}
		getSession(authority, options) {
			options = Object.assign({ sessionTimeout: 1e3 }, options);
			let authoritySessions = this.sessions[authority];
			if (authoritySessions) {
				let len = authoritySessions.length;
				for (let i = 0; i < len; i++) {
					const [sessionHandle, sessionOptions] = authoritySessions[i];
					if (!sessionHandle.destroyed && !sessionHandle.closed && util.isDeepStrictEqual(sessionOptions, options)) return sessionHandle;
				}
			}
			const session = http2.connect(authority, options);
			let removed;
			const removeSession = () => {
				if (removed) return;
				removed = true;
				let entries = authoritySessions, len = entries.length, i = len;
				while (i--) if (entries[i][0] === session) {
					if (len === 1) delete this.sessions[authority];
					else entries.splice(i, 1);
					if (!session.closed) session.close();
					return;
				}
			};
			const originalRequestFn = session.request;
			const { sessionTimeout } = options;
			if (sessionTimeout != null) {
				let timer;
				let streamsCount = 0;
				session.request = function() {
					const stream = originalRequestFn.apply(this, arguments);
					streamsCount++;
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
					stream.once("close", () => {
						if (!--streamsCount) timer = setTimeout(() => {
							timer = null;
							removeSession();
						}, sessionTimeout);
					});
					return stream;
				};
			}
			session.once("close", removeSession);
			let entry = [session, options];
			authoritySessions ? authoritySessions.push(entry) : authoritySessions = this.sessions[authority] = [entry];
			return session;
		}
	};
	const http2Sessions = new Http2Sessions();
	/**
	* If the proxy or config beforeRedirects functions are defined, call them with the options
	* object.
	*
	* @param {Object<string, any>} options - The options object that was passed to the request.
	*
	* @returns {Object<string, any>}
	*/
	function dispatchBeforeRedirect(options, responseDetails, requestDetails) {
		if (options.beforeRedirects.proxy) options.beforeRedirects.proxy(options);
		if (options.beforeRedirects.config) options.beforeRedirects.config(options, responseDetails, requestDetails);
	}
	/**
	* If the proxy or config afterRedirects functions are defined, call them with the options
	*
	* @param {http.ClientRequestArgs} options
	* @param {AxiosProxyConfig} configProxy configuration from Axios options object
	* @param {string} location
	*
	* @returns {http.ClientRequestArgs}
	*/
	function setProxy(options, configProxy, location, isRedirect) {
		let proxy = configProxy;
		if (!proxy && proxy !== false) {
			const proxyUrl = getProxyForUrl(location);
			if (proxyUrl) {
				if (!shouldBypassProxy(location)) proxy = new URL(proxyUrl);
			}
		}
		if (isRedirect && options.headers) {
			for (const name of Object.keys(options.headers)) if (name.toLowerCase() === "proxy-authorization") delete options.headers[name];
		}
		if (proxy) {
			const isProxyURL = proxy instanceof URL;
			const readProxyField = (key) => isProxyURL || utils$1.hasOwnProp(proxy, key) ? proxy[key] : void 0;
			const proxyUsername = readProxyField("username");
			const proxyPassword = readProxyField("password");
			let proxyAuth = utils$1.hasOwnProp(proxy, "auth") ? proxy.auth : void 0;
			if (proxyUsername) proxyAuth = (proxyUsername || "") + ":" + (proxyPassword || "");
			if (proxyAuth) {
				const authIsObject = typeof proxyAuth === "object";
				const authUsername = authIsObject && utils$1.hasOwnProp(proxyAuth, "username") ? proxyAuth.username : void 0;
				const authPassword = authIsObject && utils$1.hasOwnProp(proxyAuth, "password") ? proxyAuth.password : void 0;
				if (Boolean(authUsername || authPassword)) proxyAuth = (authUsername || "") + ":" + (authPassword || "");
				else if (authIsObject) throw new AxiosError("Invalid proxy authorization", AxiosError.ERR_BAD_OPTION, { proxy });
				const base64 = Buffer.from(proxyAuth, "utf8").toString("base64");
				options.headers["Proxy-Authorization"] = "Basic " + base64;
			}
			let hasUserHostHeader = false;
			for (const name of Object.keys(options.headers)) if (name.toLowerCase() === "host") {
				hasUserHostHeader = true;
				break;
			}
			if (!hasUserHostHeader) options.headers.host = options.hostname + (options.port ? ":" + options.port : "");
			const proxyHost = readProxyField("hostname") || readProxyField("host");
			options.hostname = proxyHost;
			options.host = proxyHost;
			options.port = readProxyField("port");
			options.path = location;
			const proxyProtocol = readProxyField("protocol");
			if (proxyProtocol) options.protocol = proxyProtocol.includes(":") ? proxyProtocol : `${proxyProtocol}:`;
		}
		options.beforeRedirects.proxy = function beforeRedirect(redirectOptions) {
			setProxy(redirectOptions, configProxy, redirectOptions.href, true);
		};
	}
	const isHttpAdapterSupported = typeof process !== "undefined" && utils$1.kindOf(process) === "process";
	const wrapAsync = (asyncExecutor) => {
		return new Promise((resolve, reject) => {
			let onDone;
			let isDone;
			const done = (value, isRejected) => {
				if (isDone) return;
				isDone = true;
				onDone && onDone(value, isRejected);
			};
			const _resolve = (value) => {
				done(value);
				resolve(value);
			};
			const _reject = (reason) => {
				done(reason, true);
				reject(reason);
			};
			asyncExecutor(_resolve, _reject, (onDoneHandler) => onDone = onDoneHandler).catch(_reject);
		});
	};
	const resolveFamily = ({ address, family }) => {
		if (!utils$1.isString(address)) throw TypeError("address must be a string");
		return {
			address,
			family: family || (address.indexOf(".") < 0 ? 6 : 4)
		};
	};
	const buildAddressEntry = (address, family) => resolveFamily(utils$1.isObject(address) ? address : {
		address,
		family
	});
	const http2Transport = { request(options, cb) {
		const authority = options.protocol + "//" + options.hostname + ":" + (options.port || (options.protocol === "https:" ? 443 : 80));
		const { http2Options, headers } = options;
		const session = http2Sessions.getSession(authority, http2Options);
		const { HTTP2_HEADER_SCHEME, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS } = http2.constants;
		const http2Headers = {
			[HTTP2_HEADER_SCHEME]: options.protocol.replace(":", ""),
			[HTTP2_HEADER_METHOD]: options.method,
			[HTTP2_HEADER_PATH]: options.path
		};
		utils$1.forEach(headers, (header, name) => {
			name.charAt(0) !== ":" && (http2Headers[name] = header);
		});
		const req = session.request(http2Headers);
		req.once("response", (responseHeaders) => {
			const response = req;
			responseHeaders = Object.assign({}, responseHeaders);
			const status = responseHeaders[HTTP2_HEADER_STATUS];
			delete responseHeaders[HTTP2_HEADER_STATUS];
			response.headers = responseHeaders;
			response.statusCode = +status;
			cb(response);
		});
		return req;
	} };
	var httpAdapter = isHttpAdapterSupported && function httpAdapter(config) {
		return wrapAsync(async function dispatchHttpRequest(resolve, reject, onDone) {
			const own = (key) => utils$1.hasOwnProp(config, key) ? config[key] : void 0;
			let data = own("data");
			let lookup = own("lookup");
			let family = own("family");
			let httpVersion = own("httpVersion");
			if (httpVersion === void 0) httpVersion = 1;
			let http2Options = own("http2Options");
			const responseType = own("responseType");
			const responseEncoding = own("responseEncoding");
			const method = config.method.toUpperCase();
			let isDone;
			let rejected = false;
			let req;
			let connectPhaseTimer;
			httpVersion = +httpVersion;
			if (Number.isNaN(httpVersion)) throw TypeError(`Invalid protocol version: '${config.httpVersion}' is not a number`);
			if (httpVersion !== 1 && httpVersion !== 2) throw TypeError(`Unsupported protocol version '${httpVersion}'`);
			const isHttp2 = httpVersion === 2;
			if (lookup) {
				const _lookup = callbackify(lookup, (value) => utils$1.isArray(value) ? value : [value]);
				lookup = (hostname, opt, cb) => {
					_lookup(hostname, opt, (err, arg0, arg1) => {
						if (err) return cb(err);
						const addresses = utils$1.isArray(arg0) ? arg0.map((addr) => buildAddressEntry(addr)) : [buildAddressEntry(arg0, arg1)];
						opt.all ? cb(err, addresses) : cb(err, addresses[0].address, addresses[0].family);
					});
				};
			}
			const abortEmitter = new events.EventEmitter();
			function abort(reason) {
				try {
					abortEmitter.emit("abort", !reason || reason.type ? new CanceledError(null, config, req) : reason);
				} catch (err) {
					console.warn("emit error", err);
				}
			}
			function clearConnectPhaseTimer() {
				if (connectPhaseTimer) {
					clearTimeout(connectPhaseTimer);
					connectPhaseTimer = null;
				}
			}
			function createTimeoutError() {
				let timeoutErrorMessage = config.timeout ? "timeout of " + config.timeout + "ms exceeded" : "timeout exceeded";
				const transitional = config.transitional || transitionalDefaults;
				if (config.timeoutErrorMessage) timeoutErrorMessage = config.timeoutErrorMessage;
				return new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, req);
			}
			abortEmitter.once("abort", reject);
			const onFinished = () => {
				clearConnectPhaseTimer();
				if (config.cancelToken) config.cancelToken.unsubscribe(abort);
				if (config.signal) config.signal.removeEventListener("abort", abort);
				abortEmitter.removeAllListeners();
			};
			if (config.cancelToken || config.signal) {
				config.cancelToken && config.cancelToken.subscribe(abort);
				if (config.signal) config.signal.aborted ? abort() : config.signal.addEventListener("abort", abort);
			}
			onDone((response, isRejected) => {
				isDone = true;
				clearConnectPhaseTimer();
				if (isRejected) {
					rejected = true;
					onFinished();
					return;
				}
				const { data } = response;
				if (data instanceof stream.Readable || data instanceof stream.Duplex) {
					const offListeners = stream.finished(data, () => {
						offListeners();
						onFinished();
					});
				} else onFinished();
			});
			const fullPath = buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls);
			const parsed = new URL(fullPath, platform.hasBrowserEnv ? platform.origin : void 0);
			const protocol = parsed.protocol || supportedProtocols[0];
			if (protocol === "data:") {
				if (config.maxContentLength > -1) {
					if (estimateDataURLDecodedBytes(String(config.url || fullPath || "")) > config.maxContentLength) return reject(new AxiosError("maxContentLength size of " + config.maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config));
				}
				let convertedData;
				if (method !== "GET") return settle(resolve, reject, {
					status: 405,
					statusText: "method not allowed",
					headers: {},
					config
				});
				try {
					convertedData = fromDataURI(config.url, responseType === "blob", { Blob: config.env && config.env.Blob });
				} catch (err) {
					throw AxiosError.from(err, AxiosError.ERR_BAD_REQUEST, config);
				}
				if (responseType === "text") {
					convertedData = convertedData.toString(responseEncoding);
					if (!responseEncoding || responseEncoding === "utf8") convertedData = utils$1.stripBOM(convertedData);
				} else if (responseType === "stream") convertedData = stream.Readable.from(convertedData);
				return settle(resolve, reject, {
					data: convertedData,
					status: 200,
					statusText: "OK",
					headers: new AxiosHeaders(),
					config
				});
			}
			if (supportedProtocols.indexOf(protocol) === -1) return reject(new AxiosError("Unsupported protocol " + protocol, AxiosError.ERR_BAD_REQUEST, config));
			const headers = AxiosHeaders.from(config.headers).normalize();
			headers.set("User-Agent", "axios/1.16.0", false);
			const { onUploadProgress, onDownloadProgress } = config;
			const maxRate = config.maxRate;
			let maxUploadRate = void 0;
			let maxDownloadRate = void 0;
			if (utils$1.isSpecCompliantForm(data)) {
				const userBoundary = headers.getContentType(/boundary=([-_\w\d]{10,70})/i);
				data = formDataToStream(data, (formHeaders) => {
					headers.set(formHeaders);
				}, {
					tag: `axios-${VERSION}-boundary`,
					boundary: userBoundary && userBoundary[1] || void 0
				});
			} else if (utils$1.isFormData(data) && utils$1.isFunction(data.getHeaders) && data.getHeaders !== Object.prototype.getHeaders) {
				setFormDataHeaders$1(headers, data.getHeaders(), own("formDataHeaderPolicy"));
				if (!headers.hasContentLength()) try {
					const knownLength = await util.promisify(data.getLength).call(data);
					Number.isFinite(knownLength) && knownLength >= 0 && headers.setContentLength(knownLength);
				} catch (e) {}
			} else if (utils$1.isBlob(data) || utils$1.isFile(data)) {
				data.size && headers.setContentType(data.type || "application/octet-stream");
				headers.setContentLength(data.size || 0);
				data = stream.Readable.from(readBlob(data));
			} else if (data && !utils$1.isStream(data)) {
				if (Buffer.isBuffer(data));
				else if (utils$1.isArrayBuffer(data)) data = Buffer.from(new Uint8Array(data));
				else if (utils$1.isString(data)) data = Buffer.from(data, "utf-8");
				else return reject(new AxiosError("Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream", AxiosError.ERR_BAD_REQUEST, config));
				headers.setContentLength(data.length, false);
				if (config.maxBodyLength > -1 && data.length > config.maxBodyLength) return reject(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config));
			}
			const contentLength = utils$1.toFiniteNumber(headers.getContentLength());
			if (utils$1.isArray(maxRate)) {
				maxUploadRate = maxRate[0];
				maxDownloadRate = maxRate[1];
			} else maxUploadRate = maxDownloadRate = maxRate;
			if (data && (onUploadProgress || maxUploadRate)) {
				if (!utils$1.isStream(data)) data = stream.Readable.from(data, { objectMode: false });
				data = stream.pipeline([data, new AxiosTransformStream({ maxRate: utils$1.toFiniteNumber(maxUploadRate) })], utils$1.noop);
				onUploadProgress && data.on("progress", flushOnFinish(data, progressEventDecorator(contentLength, progressEventReducer(asyncDecorator(onUploadProgress), false, 3))));
			}
			let auth = void 0;
			const configAuth = own("auth");
			if (configAuth) {
				const username = configAuth.username || "";
				const password = configAuth.password || "";
				auth = username + ":" + password;
			}
			if (!auth && parsed.username) {
				const urlUsername = decodeURIComponentSafe(parsed.username);
				const urlPassword = decodeURIComponentSafe(parsed.password);
				auth = urlUsername + ":" + urlPassword;
			}
			auth && headers.delete("authorization");
			let path$1;
			try {
				path$1 = buildURL(parsed.pathname + parsed.search, config.params, config.paramsSerializer).replace(/^\?/, "");
			} catch (err) {
				const customErr = new Error(err.message);
				customErr.config = config;
				customErr.url = config.url;
				customErr.exists = true;
				return reject(customErr);
			}
			headers.set("Accept-Encoding", "gzip, compress, deflate" + (isBrotliSupported ? ", br" : ""), false);
			const options = Object.assign(Object.create(null), {
				path: path$1,
				method,
				headers: headers.toJSON(),
				agents: {
					http: config.httpAgent,
					https: config.httpsAgent
				},
				auth,
				protocol,
				family,
				beforeRedirect: dispatchBeforeRedirect,
				beforeRedirects: Object.create(null),
				http2Options
			});
			!utils$1.isUndefined(lookup) && (options.lookup = lookup);
			if (config.socketPath) {
				if (typeof config.socketPath !== "string") return reject(new AxiosError("socketPath must be a string", AxiosError.ERR_BAD_OPTION_VALUE, config));
				if (config.allowedSocketPaths != null) {
					const allowed = Array.isArray(config.allowedSocketPaths) ? config.allowedSocketPaths : [config.allowedSocketPaths];
					const resolvedSocket = path.resolve(config.socketPath);
					if (!allowed.some((entry) => typeof entry === "string" && path.resolve(entry) === resolvedSocket)) return reject(new AxiosError(`socketPath "${config.socketPath}" is not permitted by allowedSocketPaths`, AxiosError.ERR_BAD_OPTION_VALUE, config));
				}
				options.socketPath = config.socketPath;
			} else {
				options.hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
				options.port = parsed.port;
				setProxy(options, config.proxy, protocol + "//" + parsed.hostname + (parsed.port ? ":" + parsed.port : "") + options.path);
			}
			let transport;
			let isNativeTransport = false;
			const isHttpsRequest = isHttps.test(options.protocol);
			options.agent = isHttpsRequest ? config.httpsAgent : config.httpAgent;
			if (isHttp2) transport = http2Transport;
			else {
				const configTransport = own("transport");
				if (configTransport) transport = configTransport;
				else if (config.maxRedirects === 0) {
					transport = isHttpsRequest ? https : http;
					isNativeTransport = true;
				} else {
					if (config.maxRedirects) options.maxRedirects = config.maxRedirects;
					const configBeforeRedirect = own("beforeRedirect");
					if (configBeforeRedirect) options.beforeRedirects.config = configBeforeRedirect;
					transport = isHttpsRequest ? httpsFollow : httpFollow;
				}
			}
			if (config.maxBodyLength > -1) options.maxBodyLength = config.maxBodyLength;
			else options.maxBodyLength = Infinity;
			options.insecureHTTPParser = Boolean(own("insecureHTTPParser"));
			req = transport.request(options, function handleResponse(res) {
				clearConnectPhaseTimer();
				if (req.destroyed) return;
				const streams = [res];
				const responseLength = utils$1.toFiniteNumber(res.headers["content-length"]);
				if (onDownloadProgress || maxDownloadRate) {
					const transformStream = new AxiosTransformStream({ maxRate: utils$1.toFiniteNumber(maxDownloadRate) });
					onDownloadProgress && transformStream.on("progress", flushOnFinish(transformStream, progressEventDecorator(responseLength, progressEventReducer(asyncDecorator(onDownloadProgress), true, 3))));
					streams.push(transformStream);
				}
				let responseStream = res;
				const lastRequest = res.req || req;
				if (config.decompress !== false && res.headers["content-encoding"]) {
					if (method === "HEAD" || res.statusCode === 204) delete res.headers["content-encoding"];
					switch ((res.headers["content-encoding"] || "").toLowerCase()) {
						case "gzip":
						case "x-gzip":
						case "compress":
						case "x-compress":
							streams.push(zlib.createUnzip(zlibOptions));
							delete res.headers["content-encoding"];
							break;
						case "deflate":
							streams.push(new ZlibHeaderTransformStream());
							streams.push(zlib.createUnzip(zlibOptions));
							delete res.headers["content-encoding"];
							break;
						case "br": if (isBrotliSupported) {
							streams.push(zlib.createBrotliDecompress(brotliOptions));
							delete res.headers["content-encoding"];
						}
					}
				}
				responseStream = streams.length > 1 ? stream.pipeline(streams, utils$1.noop) : streams[0];
				const response = {
					status: res.statusCode,
					statusText: res.statusMessage,
					headers: new AxiosHeaders(res.headers),
					config,
					request: lastRequest
				};
				if (responseType === "stream") {
					if (config.maxContentLength > -1) {
						const limit = config.maxContentLength;
						const source = responseStream;
						async function* enforceMaxContentLength() {
							let totalResponseBytes = 0;
							for await (const chunk of source) {
								totalResponseBytes += chunk.length;
								if (totalResponseBytes > limit) throw new AxiosError("maxContentLength size of " + limit + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest);
								yield chunk;
							}
						}
						responseStream = stream.Readable.from(enforceMaxContentLength(), { objectMode: false });
					}
					response.data = responseStream;
					settle(resolve, reject, response);
				} else {
					const responseBuffer = [];
					let totalResponseBytes = 0;
					responseStream.on("data", function handleStreamData(chunk) {
						responseBuffer.push(chunk);
						totalResponseBytes += chunk.length;
						if (config.maxContentLength > -1 && totalResponseBytes > config.maxContentLength) {
							rejected = true;
							responseStream.destroy();
							abort(new AxiosError("maxContentLength size of " + config.maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, lastRequest));
						}
					});
					responseStream.on("aborted", function handlerStreamAborted() {
						if (rejected) return;
						const err = new AxiosError("stream has been aborted", AxiosError.ERR_BAD_RESPONSE, config, lastRequest, response);
						responseStream.destroy(err);
						reject(err);
					});
					responseStream.on("error", function handleStreamError(err) {
						if (rejected) return;
						reject(AxiosError.from(err, null, config, lastRequest, response));
					});
					responseStream.on("end", function handleStreamEnd() {
						try {
							let responseData = responseBuffer.length === 1 ? responseBuffer[0] : Buffer.concat(responseBuffer);
							if (responseType !== "arraybuffer") {
								responseData = responseData.toString(responseEncoding);
								if (!responseEncoding || responseEncoding === "utf8") responseData = utils$1.stripBOM(responseData);
							}
							response.data = responseData;
						} catch (err) {
							return reject(AxiosError.from(err, null, config, response.request, response));
						}
						settle(resolve, reject, response);
					});
				}
				abortEmitter.once("abort", (err) => {
					if (!responseStream.destroyed) {
						responseStream.emit("error", err);
						responseStream.destroy();
					}
				});
			});
			abortEmitter.once("abort", (err) => {
				if (req.close) req.close();
				else req.destroy(err);
			});
			req.on("error", function handleRequestError(err) {
				reject(AxiosError.from(err, null, config, req));
			});
			const boundSockets = /* @__PURE__ */ new Set();
			req.on("socket", function handleRequestSocket(socket) {
				socket.setKeepAlive(true, 1e3 * 60);
				if (!socket[kAxiosSocketListener]) {
					socket.on("error", function handleSocketError(err) {
						const current = socket[kAxiosCurrentReq];
						if (current && !current.destroyed) current.destroy(err);
					});
					socket[kAxiosSocketListener] = true;
				}
				socket[kAxiosCurrentReq] = req;
				boundSockets.add(socket);
			});
			req.once("close", function clearCurrentReq() {
				clearConnectPhaseTimer();
				for (const socket of boundSockets) if (socket[kAxiosCurrentReq] === req) socket[kAxiosCurrentReq] = null;
				boundSockets.clear();
			});
			if (config.timeout) {
				const timeout = parseInt(config.timeout, 10);
				if (Number.isNaN(timeout)) {
					abort(new AxiosError("error trying to parse `config.timeout` to int", AxiosError.ERR_BAD_OPTION_VALUE, config, req));
					return;
				}
				const handleTimeout = function handleTimeout() {
					if (isDone) return;
					abort(createTimeoutError());
				};
				if (isNativeTransport && timeout > 0) connectPhaseTimer = setTimeout(handleTimeout, timeout);
				req.setTimeout(timeout, handleTimeout);
			} else req.setTimeout(0);
			if (utils$1.isStream(data)) {
				let ended = false;
				let errored = false;
				data.on("end", () => {
					ended = true;
				});
				data.once("error", (err) => {
					errored = true;
					req.destroy(err);
				});
				data.on("close", () => {
					if (!ended && !errored) abort(new CanceledError("Request stream has been aborted", config, req));
				});
				let uploadStream = data;
				if (config.maxBodyLength > -1 && config.maxRedirects === 0) {
					const limit = config.maxBodyLength;
					let bytesSent = 0;
					uploadStream = stream.pipeline([data, new stream.Transform({ transform(chunk, _enc, cb) {
						bytesSent += chunk.length;
						if (bytesSent > limit) return cb(new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, req));
						cb(null, chunk);
					} })], utils$1.noop);
					uploadStream.on("error", (err) => {
						if (!req.destroyed) req.destroy(err);
					});
				}
				uploadStream.pipe(req);
			} else {
				data && req.write(data);
				req.end();
			}
		});
	};
	var isURLSameOrigin = platform.hasStandardBrowserEnv ? ((origin, isMSIE) => (url) => {
		url = new URL(url, platform.origin);
		return origin.protocol === url.protocol && origin.host === url.host && (isMSIE || origin.port === url.port);
	})(new URL(platform.origin), platform.navigator && /(msie|trident)/i.test(platform.navigator.userAgent)) : () => true;
	var cookies = platform.hasStandardBrowserEnv ? {
		write(name, value, expires, path, domain, secure, sameSite) {
			if (typeof document === "undefined") return;
			const cookie = [`${name}=${encodeURIComponent(value)}`];
			if (utils$1.isNumber(expires)) cookie.push(`expires=${new Date(expires).toUTCString()}`);
			if (utils$1.isString(path)) cookie.push(`path=${path}`);
			if (utils$1.isString(domain)) cookie.push(`domain=${domain}`);
			if (secure === true) cookie.push("secure");
			if (utils$1.isString(sameSite)) cookie.push(`SameSite=${sameSite}`);
			document.cookie = cookie.join("; ");
		},
		read(name) {
			if (typeof document === "undefined") return null;
			const cookies = document.cookie.split(";");
			for (let i = 0; i < cookies.length; i++) {
				const cookie = cookies[i].replace(/^\s+/, "");
				const eq = cookie.indexOf("=");
				if (eq !== -1 && cookie.slice(0, eq) === name) return decodeURIComponent(cookie.slice(eq + 1));
			}
			return null;
		},
		remove(name) {
			this.write(name, "", Date.now() - 864e5, "/");
		}
	} : {
		write() {},
		read() {
			return null;
		},
		remove() {}
	};
	const headersToObject = (thing) => thing instanceof AxiosHeaders ? { ...thing } : thing;
	/**
	* Config-specific merge-function which creates a new config-object
	* by merging two configuration objects together.
	*
	* @param {Object} config1
	* @param {Object} config2
	*
	* @returns {Object} New object resulting from merging config2 to config1
	*/
	function mergeConfig(config1, config2) {
		config2 = config2 || {};
		const config = Object.create(null);
		Object.defineProperty(config, "hasOwnProperty", {
			__proto__: null,
			value: Object.prototype.hasOwnProperty,
			enumerable: false,
			writable: true,
			configurable: true
		});
		function getMergedValue(target, source, prop, caseless) {
			if (utils$1.isPlainObject(target) && utils$1.isPlainObject(source)) return utils$1.merge.call({ caseless }, target, source);
			else if (utils$1.isPlainObject(source)) return utils$1.merge({}, source);
			else if (utils$1.isArray(source)) return source.slice();
			return source;
		}
		function mergeDeepProperties(a, b, prop, caseless) {
			if (!utils$1.isUndefined(b)) return getMergedValue(a, b, prop, caseless);
			else if (!utils$1.isUndefined(a)) return getMergedValue(void 0, a, prop, caseless);
		}
		function valueFromConfig2(a, b) {
			if (!utils$1.isUndefined(b)) return getMergedValue(void 0, b);
		}
		function defaultToConfig2(a, b) {
			if (!utils$1.isUndefined(b)) return getMergedValue(void 0, b);
			else if (!utils$1.isUndefined(a)) return getMergedValue(void 0, a);
		}
		function mergeDirectKeys(a, b, prop) {
			if (utils$1.hasOwnProp(config2, prop)) return getMergedValue(a, b);
			else if (utils$1.hasOwnProp(config1, prop)) return getMergedValue(void 0, a);
		}
		const mergeMap = {
			url: valueFromConfig2,
			method: valueFromConfig2,
			data: valueFromConfig2,
			baseURL: defaultToConfig2,
			transformRequest: defaultToConfig2,
			transformResponse: defaultToConfig2,
			paramsSerializer: defaultToConfig2,
			timeout: defaultToConfig2,
			timeoutMessage: defaultToConfig2,
			withCredentials: defaultToConfig2,
			withXSRFToken: defaultToConfig2,
			adapter: defaultToConfig2,
			responseType: defaultToConfig2,
			xsrfCookieName: defaultToConfig2,
			xsrfHeaderName: defaultToConfig2,
			onUploadProgress: defaultToConfig2,
			onDownloadProgress: defaultToConfig2,
			decompress: defaultToConfig2,
			maxContentLength: defaultToConfig2,
			maxBodyLength: defaultToConfig2,
			beforeRedirect: defaultToConfig2,
			transport: defaultToConfig2,
			httpAgent: defaultToConfig2,
			httpsAgent: defaultToConfig2,
			cancelToken: defaultToConfig2,
			socketPath: defaultToConfig2,
			allowedSocketPaths: defaultToConfig2,
			responseEncoding: defaultToConfig2,
			validateStatus: mergeDirectKeys,
			headers: (a, b, prop) => mergeDeepProperties(headersToObject(a), headersToObject(b), prop, true)
		};
		utils$1.forEach(Object.keys({
			...config1,
			...config2
		}), function computeConfigValue(prop) {
			if (prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
			const merge = utils$1.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : mergeDeepProperties;
			const configValue = merge(utils$1.hasOwnProp(config1, prop) ? config1[prop] : void 0, utils$1.hasOwnProp(config2, prop) ? config2[prop] : void 0, prop);
			utils$1.isUndefined(configValue) && merge !== mergeDirectKeys || (config[prop] = configValue);
		});
		return config;
	}
	const FORM_DATA_CONTENT_HEADERS = ["content-type", "content-length"];
	function setFormDataHeaders(headers, formHeaders, policy) {
		if (policy !== "content-only") {
			headers.set(formHeaders);
			return;
		}
		Object.entries(formHeaders).forEach(([key, val]) => {
			if (FORM_DATA_CONTENT_HEADERS.includes(key.toLowerCase())) headers.set(key, val);
		});
	}
	/**
	* Encode a UTF-8 string to a Latin-1 byte string for use with btoa().
	* This is a modern replacement for the deprecated unescape(encodeURIComponent(str)) pattern.
	*
	* @param {string} str The string to encode
	*
	* @returns {string} UTF-8 bytes as a Latin-1 string
	*/
	const encodeUTF8 = (str) => encodeURIComponent(str).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
	var resolveConfig = (config) => {
		const newConfig = mergeConfig({}, config);
		const own = (key) => utils$1.hasOwnProp(newConfig, key) ? newConfig[key] : void 0;
		const data = own("data");
		let withXSRFToken = own("withXSRFToken");
		const xsrfHeaderName = own("xsrfHeaderName");
		const xsrfCookieName = own("xsrfCookieName");
		let headers = own("headers");
		const auth = own("auth");
		const baseURL = own("baseURL");
		const allowAbsoluteUrls = own("allowAbsoluteUrls");
		const url = own("url");
		newConfig.headers = headers = AxiosHeaders.from(headers);
		newConfig.url = buildURL(buildFullPath(baseURL, url, allowAbsoluteUrls), config.params, config.paramsSerializer);
		if (auth) headers.set("Authorization", "Basic " + btoa((auth.username || "") + ":" + (auth.password ? encodeUTF8(auth.password) : "")));
		if (utils$1.isFormData(data)) {
			if (platform.hasStandardBrowserEnv || platform.hasStandardBrowserWebWorkerEnv) headers.setContentType(void 0);
			else if (utils$1.isFunction(data.getHeaders)) setFormDataHeaders(headers, data.getHeaders(), own("formDataHeaderPolicy"));
		}
		if (platform.hasStandardBrowserEnv) {
			if (utils$1.isFunction(withXSRFToken)) withXSRFToken = withXSRFToken(newConfig);
			if (withXSRFToken === true || withXSRFToken == null && isURLSameOrigin(newConfig.url)) {
				const xsrfValue = xsrfHeaderName && xsrfCookieName && cookies.read(xsrfCookieName);
				if (xsrfValue) headers.set(xsrfHeaderName, xsrfValue);
			}
		}
		return newConfig;
	};
	var xhrAdapter = typeof XMLHttpRequest !== "undefined" && function(config) {
		return new Promise(function dispatchXhrRequest(resolve, reject) {
			const _config = resolveConfig(config);
			let requestData = _config.data;
			const requestHeaders = AxiosHeaders.from(_config.headers).normalize();
			let { responseType, onUploadProgress, onDownloadProgress } = _config;
			let onCanceled;
			let uploadThrottled, downloadThrottled;
			let flushUpload, flushDownload;
			function done() {
				flushUpload && flushUpload();
				flushDownload && flushDownload();
				_config.cancelToken && _config.cancelToken.unsubscribe(onCanceled);
				_config.signal && _config.signal.removeEventListener("abort", onCanceled);
			}
			let request = new XMLHttpRequest();
			request.open(_config.method.toUpperCase(), _config.url, true);
			request.timeout = _config.timeout;
			function onloadend() {
				if (!request) return;
				const responseHeaders = AxiosHeaders.from("getAllResponseHeaders" in request && request.getAllResponseHeaders());
				settle(function _resolve(value) {
					resolve(value);
					done();
				}, function _reject(err) {
					reject(err);
					done();
				}, {
					data: !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response,
					status: request.status,
					statusText: request.statusText,
					headers: responseHeaders,
					config,
					request
				});
				request = null;
			}
			if ("onloadend" in request) request.onloadend = onloadend;
			else request.onreadystatechange = function handleLoad() {
				if (!request || request.readyState !== 4) return;
				if (request.status === 0 && !(request.responseURL && request.responseURL.startsWith("file:"))) return;
				setTimeout(onloadend);
			};
			request.onabort = function handleAbort() {
				if (!request) return;
				reject(new AxiosError("Request aborted", AxiosError.ECONNABORTED, config, request));
				done();
				request = null;
			};
			request.onerror = function handleError(event) {
				const err = new AxiosError(event && event.message ? event.message : "Network Error", AxiosError.ERR_NETWORK, config, request);
				err.event = event || null;
				reject(err);
				done();
				request = null;
			};
			request.ontimeout = function handleTimeout() {
				let timeoutErrorMessage = _config.timeout ? "timeout of " + _config.timeout + "ms exceeded" : "timeout exceeded";
				const transitional = _config.transitional || transitionalDefaults;
				if (_config.timeoutErrorMessage) timeoutErrorMessage = _config.timeoutErrorMessage;
				reject(new AxiosError(timeoutErrorMessage, transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED, config, request));
				done();
				request = null;
			};
			requestData === void 0 && requestHeaders.setContentType(null);
			if ("setRequestHeader" in request) utils$1.forEach(requestHeaders.toJSON(), function setRequestHeader(val, key) {
				request.setRequestHeader(key, val);
			});
			if (!utils$1.isUndefined(_config.withCredentials)) request.withCredentials = !!_config.withCredentials;
			if (responseType && responseType !== "json") request.responseType = _config.responseType;
			if (onDownloadProgress) {
				[downloadThrottled, flushDownload] = progressEventReducer(onDownloadProgress, true);
				request.addEventListener("progress", downloadThrottled);
			}
			if (onUploadProgress && request.upload) {
				[uploadThrottled, flushUpload] = progressEventReducer(onUploadProgress);
				request.upload.addEventListener("progress", uploadThrottled);
				request.upload.addEventListener("loadend", flushUpload);
			}
			if (_config.cancelToken || _config.signal) {
				onCanceled = (cancel) => {
					if (!request) return;
					reject(!cancel || cancel.type ? new CanceledError(null, config, request) : cancel);
					request.abort();
					done();
					request = null;
				};
				_config.cancelToken && _config.cancelToken.subscribe(onCanceled);
				if (_config.signal) _config.signal.aborted ? onCanceled() : _config.signal.addEventListener("abort", onCanceled);
			}
			const protocol = parseProtocol(_config.url);
			if (protocol && !platform.protocols.includes(protocol)) {
				reject(new AxiosError("Unsupported protocol " + protocol + ":", AxiosError.ERR_BAD_REQUEST, config));
				return;
			}
			request.send(requestData || null);
		});
	};
	const composeSignals = (signals, timeout) => {
		const { length } = signals = signals ? signals.filter(Boolean) : [];
		if (timeout || length) {
			let controller = new AbortController();
			let aborted;
			const onabort = function(reason) {
				if (!aborted) {
					aborted = true;
					unsubscribe();
					const err = reason instanceof Error ? reason : this.reason;
					controller.abort(err instanceof AxiosError ? err : new CanceledError(err instanceof Error ? err.message : err));
				}
			};
			let timer = timeout && setTimeout(() => {
				timer = null;
				onabort(new AxiosError(`timeout of ${timeout}ms exceeded`, AxiosError.ETIMEDOUT));
			}, timeout);
			const unsubscribe = () => {
				if (signals) {
					timer && clearTimeout(timer);
					timer = null;
					signals.forEach((signal) => {
						signal.unsubscribe ? signal.unsubscribe(onabort) : signal.removeEventListener("abort", onabort);
					});
					signals = null;
				}
			};
			signals.forEach((signal) => signal.addEventListener("abort", onabort));
			const { signal } = controller;
			signal.unsubscribe = () => utils$1.asap(unsubscribe);
			return signal;
		}
	};
	const streamChunk = function* (chunk, chunkSize) {
		let len = chunk.byteLength;
		if (len < chunkSize) {
			yield chunk;
			return;
		}
		let pos = 0;
		let end;
		while (pos < len) {
			end = pos + chunkSize;
			yield chunk.slice(pos, end);
			pos = end;
		}
	};
	const readBytes = async function* (iterable, chunkSize) {
		for await (const chunk of readStream(iterable)) yield* streamChunk(chunk, chunkSize);
	};
	const readStream = async function* (stream) {
		if (stream[Symbol.asyncIterator]) {
			yield* stream;
			return;
		}
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				yield value;
			}
		} finally {
			await reader.cancel();
		}
	};
	const trackStream = (stream, chunkSize, onProgress, onFinish) => {
		const iterator = readBytes(stream, chunkSize);
		let bytes = 0;
		let done;
		let _onFinish = (e) => {
			if (!done) {
				done = true;
				onFinish && onFinish(e);
			}
		};
		return new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await iterator.next();
					if (done) {
						_onFinish();
						controller.close();
						return;
					}
					let len = value.byteLength;
					if (onProgress) onProgress(bytes += len);
					controller.enqueue(new Uint8Array(value));
				} catch (err) {
					_onFinish(err);
					throw err;
				}
			},
			cancel(reason) {
				_onFinish(reason);
				return iterator.return();
			}
		}, { highWaterMark: 2 });
	};
	const DEFAULT_CHUNK_SIZE = 64 * 1024;
	const { isFunction } = utils$1;
	const test = (fn, ...args) => {
		try {
			return !!fn(...args);
		} catch (e) {
			return false;
		}
	};
	const factory = (env) => {
		var _utils$global;
		const globalObject = (_utils$global = utils$1.global) !== null && _utils$global !== void 0 ? _utils$global : globalThis;
		const { ReadableStream, TextEncoder } = globalObject;
		env = utils$1.merge.call({ skipUndefined: true }, {
			Request: globalObject.Request,
			Response: globalObject.Response
		}, env);
		const { fetch: envFetch, Request, Response } = env;
		const isFetchSupported = envFetch ? isFunction(envFetch) : typeof fetch === "function";
		const isRequestSupported = isFunction(Request);
		const isResponseSupported = isFunction(Response);
		if (!isFetchSupported) return false;
		const isReadableStreamSupported = isFetchSupported && isFunction(ReadableStream);
		const encodeText = isFetchSupported && (typeof TextEncoder === "function" ? ((encoder) => (str) => encoder.encode(str))(new TextEncoder()) : async (str) => new Uint8Array(await new Request(str).arrayBuffer()));
		const supportsRequestStream = isRequestSupported && isReadableStreamSupported && test(() => {
			let duplexAccessed = false;
			const request = new Request(platform.origin, {
				body: new ReadableStream(),
				method: "POST",
				get duplex() {
					duplexAccessed = true;
					return "half";
				}
			});
			const hasContentType = request.headers.has("Content-Type");
			if (request.body != null) request.body.cancel();
			return duplexAccessed && !hasContentType;
		});
		const supportsResponseStream = isResponseSupported && isReadableStreamSupported && test(() => utils$1.isReadableStream(new Response("").body));
		const resolvers = { stream: supportsResponseStream && ((res) => res.body) };
		isFetchSupported && [
			"text",
			"arrayBuffer",
			"blob",
			"formData",
			"stream"
		].forEach((type) => {
			!resolvers[type] && (resolvers[type] = (res, config) => {
				let method = res && res[type];
				if (method) return method.call(res);
				throw new AxiosError(`Response type '${type}' is not supported`, AxiosError.ERR_NOT_SUPPORT, config);
			});
		});
		const getBodyLength = async (body) => {
			if (body == null) return 0;
			if (utils$1.isBlob(body)) return body.size;
			if (utils$1.isSpecCompliantForm(body)) return (await new Request(platform.origin, {
				method: "POST",
				body
			}).arrayBuffer()).byteLength;
			if (utils$1.isArrayBufferView(body) || utils$1.isArrayBuffer(body)) return body.byteLength;
			if (utils$1.isURLSearchParams(body)) body = body + "";
			if (utils$1.isString(body)) return (await encodeText(body)).byteLength;
		};
		const resolveBodyLength = async (headers, body) => {
			const length = utils$1.toFiniteNumber(headers.getContentLength());
			return length == null ? getBodyLength(body) : length;
		};
		return async (config) => {
			let { url, method, data, signal, cancelToken, timeout, onDownloadProgress, onUploadProgress, responseType, headers, withCredentials = "same-origin", fetchOptions, maxContentLength, maxBodyLength } = resolveConfig(config);
			const hasMaxContentLength = utils$1.isNumber(maxContentLength) && maxContentLength > -1;
			const hasMaxBodyLength = utils$1.isNumber(maxBodyLength) && maxBodyLength > -1;
			let _fetch = envFetch || fetch;
			responseType = responseType ? (responseType + "").toLowerCase() : "text";
			let composedSignal = composeSignals([signal, cancelToken && cancelToken.toAbortSignal()], timeout);
			let request = null;
			const unsubscribe = composedSignal && composedSignal.unsubscribe && (() => {
				composedSignal.unsubscribe();
			});
			let requestContentLength;
			try {
				if (hasMaxContentLength && typeof url === "string" && url.startsWith("data:")) {
					if (estimateDataURLDecodedBytes(url) > maxContentLength) throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
				}
				if (hasMaxBodyLength && method !== "get" && method !== "head") {
					const outboundLength = await resolveBodyLength(headers, data);
					if (typeof outboundLength === "number" && isFinite(outboundLength) && outboundLength > maxBodyLength) throw new AxiosError("Request body larger than maxBodyLength limit", AxiosError.ERR_BAD_REQUEST, config, request);
				}
				if (onUploadProgress && supportsRequestStream && method !== "get" && method !== "head" && (requestContentLength = await resolveBodyLength(headers, data)) !== 0) {
					let _request = new Request(url, {
						method: "POST",
						body: data,
						duplex: "half"
					});
					let contentTypeHeader;
					if (utils$1.isFormData(data) && (contentTypeHeader = _request.headers.get("content-type"))) headers.setContentType(contentTypeHeader);
					if (_request.body) {
						const [onProgress, flush] = progressEventDecorator(requestContentLength, progressEventReducer(asyncDecorator(onUploadProgress)));
						data = trackStream(_request.body, DEFAULT_CHUNK_SIZE, onProgress, flush);
					}
				}
				if (!utils$1.isString(withCredentials)) withCredentials = withCredentials ? "include" : "omit";
				const isCredentialsSupported = isRequestSupported && "credentials" in Request.prototype;
				if (utils$1.isFormData(data)) {
					const contentType = headers.getContentType();
					if (contentType && /^multipart\/form-data/i.test(contentType) && !/boundary=/i.test(contentType)) headers.delete("content-type");
				}
				headers.set("User-Agent", "axios/1.16.0", false);
				const resolvedOptions = {
					...fetchOptions,
					signal: composedSignal,
					method: method.toUpperCase(),
					headers: headers.normalize().toJSON(),
					body: data,
					duplex: "half",
					credentials: isCredentialsSupported ? withCredentials : void 0
				};
				request = isRequestSupported && new Request(url, resolvedOptions);
				let response = await (isRequestSupported ? _fetch(request, fetchOptions) : _fetch(url, resolvedOptions));
				if (hasMaxContentLength) {
					const declaredLength = utils$1.toFiniteNumber(response.headers.get("content-length"));
					if (declaredLength != null && declaredLength > maxContentLength) throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
				}
				const isStreamResponse = supportsResponseStream && (responseType === "stream" || responseType === "response");
				if (supportsResponseStream && response.body && (onDownloadProgress || hasMaxContentLength || isStreamResponse && unsubscribe)) {
					const options = {};
					[
						"status",
						"statusText",
						"headers"
					].forEach((prop) => {
						options[prop] = response[prop];
					});
					const responseContentLength = utils$1.toFiniteNumber(response.headers.get("content-length"));
					const [onProgress, flush] = onDownloadProgress && progressEventDecorator(responseContentLength, progressEventReducer(asyncDecorator(onDownloadProgress), true)) || [];
					let bytesRead = 0;
					const onChunkProgress = (loadedBytes) => {
						if (hasMaxContentLength) {
							bytesRead = loadedBytes;
							if (bytesRead > maxContentLength) throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
						}
						onProgress && onProgress(loadedBytes);
					};
					response = new Response(trackStream(response.body, DEFAULT_CHUNK_SIZE, onChunkProgress, () => {
						flush && flush();
						unsubscribe && unsubscribe();
					}), options);
				}
				responseType = responseType || "text";
				let responseData = await resolvers[utils$1.findKey(resolvers, responseType) || "text"](response, config);
				if (hasMaxContentLength && !supportsResponseStream && !isStreamResponse) {
					let materializedSize;
					if (responseData != null) {
						if (typeof responseData.byteLength === "number") materializedSize = responseData.byteLength;
						else if (typeof responseData.size === "number") materializedSize = responseData.size;
						else if (typeof responseData === "string") materializedSize = typeof TextEncoder === "function" ? new TextEncoder().encode(responseData).byteLength : responseData.length;
					}
					if (typeof materializedSize === "number" && materializedSize > maxContentLength) throw new AxiosError("maxContentLength size of " + maxContentLength + " exceeded", AxiosError.ERR_BAD_RESPONSE, config, request);
				}
				!isStreamResponse && unsubscribe && unsubscribe();
				return await new Promise((resolve, reject) => {
					settle(resolve, reject, {
						data: responseData,
						headers: AxiosHeaders.from(response.headers),
						status: response.status,
						statusText: response.statusText,
						config,
						request
					});
				});
			} catch (err) {
				unsubscribe && unsubscribe();
				if (composedSignal && composedSignal.aborted && composedSignal.reason instanceof AxiosError) {
					const canceledError = composedSignal.reason;
					canceledError.config = config;
					request && (canceledError.request = request);
					err !== canceledError && (canceledError.cause = err);
					throw canceledError;
				}
				if (err && err.name === "TypeError" && /Load failed|fetch/i.test(err.message)) throw Object.assign(new AxiosError("Network Error", AxiosError.ERR_NETWORK, config, request, err && err.response), { cause: err.cause || err });
				throw AxiosError.from(err, err && err.code, config, request, err && err.response);
			}
		};
	};
	const seedCache = /* @__PURE__ */ new Map();
	const getFetch = (config) => {
		let env = config && config.env || {};
		const { fetch, Request, Response } = env;
		const seeds = [
			Request,
			Response,
			fetch
		];
		let i = seeds.length, seed, target, map = seedCache;
		while (i--) {
			seed = seeds[i];
			target = map.get(seed);
			target === void 0 && map.set(seed, target = i ? /* @__PURE__ */ new Map() : factory(env));
			map = target;
		}
		return target;
	};
	getFetch();
	/**
	* Known adapters mapping.
	* Provides environment-specific adapters for Axios:
	* - `http` for Node.js
	* - `xhr` for browsers
	* - `fetch` for fetch API-based requests
	*
	* @type {Object<string, Function|Object>}
	*/
	const knownAdapters = {
		http: httpAdapter,
		xhr: xhrAdapter,
		fetch: { get: getFetch }
	};
	utils$1.forEach(knownAdapters, (fn, value) => {
		if (fn) {
			try {
				Object.defineProperty(fn, "name", {
					__proto__: null,
					value
				});
			} catch (e) {}
			Object.defineProperty(fn, "adapterName", {
				__proto__: null,
				value
			});
		}
	});
	/**
	* Render a rejection reason string for unknown or unsupported adapters
	*
	* @param {string} reason
	* @returns {string}
	*/
	const renderReason = (reason) => `- ${reason}`;
	/**
	* Check if the adapter is resolved (function, null, or false)
	*
	* @param {Function|null|false} adapter
	* @returns {boolean}
	*/
	const isResolvedHandle = (adapter) => utils$1.isFunction(adapter) || adapter === null || adapter === false;
	/**
	* Get the first suitable adapter from the provided list.
	* Tries each adapter in order until a supported one is found.
	* Throws an AxiosError if no adapter is suitable.
	*
	* @param {Array<string|Function>|string|Function} adapters - Adapter(s) by name or function.
	* @param {Object} config - Axios request configuration
	* @throws {AxiosError} If no suitable adapter is available
	* @returns {Function} The resolved adapter function
	*/
	function getAdapter(adapters, config) {
		adapters = utils$1.isArray(adapters) ? adapters : [adapters];
		const { length } = adapters;
		let nameOrAdapter;
		let adapter;
		const rejectedReasons = {};
		for (let i = 0; i < length; i++) {
			nameOrAdapter = adapters[i];
			let id;
			adapter = nameOrAdapter;
			if (!isResolvedHandle(nameOrAdapter)) {
				adapter = knownAdapters[(id = String(nameOrAdapter)).toLowerCase()];
				if (adapter === void 0) throw new AxiosError(`Unknown adapter '${id}'`);
			}
			if (adapter && (utils$1.isFunction(adapter) || (adapter = adapter.get(config)))) break;
			rejectedReasons[id || "#" + i] = adapter;
		}
		if (!adapter) {
			const reasons = Object.entries(rejectedReasons).map(([id, state]) => `adapter ${id} ` + (state === false ? "is not supported by the environment" : "is not available in the build"));
			throw new AxiosError(`There is no suitable adapter to dispatch the request ` + (length ? reasons.length > 1 ? "since :\n" + reasons.map(renderReason).join("\n") : " " + renderReason(reasons[0]) : "as no adapter specified"), "ERR_NOT_SUPPORT");
		}
		return adapter;
	}
	/**
	* Exports Axios adapters and utility to resolve an adapter
	*/
	var adapters = {
		/**
		* Resolve an adapter from a list of adapter names or functions.
		* @type {Function}
		*/
		getAdapter,
		/**
		* Exposes all known adapters
		* @type {Object<string, Function|Object>}
		*/
		adapters: knownAdapters
	};
	/**
	* Throws a `CanceledError` if cancellation has been requested.
	*
	* @param {Object} config The config that is to be used for the request
	*
	* @returns {void}
	*/
	function throwIfCancellationRequested(config) {
		if (config.cancelToken) config.cancelToken.throwIfRequested();
		if (config.signal && config.signal.aborted) throw new CanceledError(null, config);
	}
	/**
	* Dispatch a request to the server using the configured adapter.
	*
	* @param {object} config The config that is to be used for the request
	*
	* @returns {Promise} The Promise to be fulfilled
	*/
	function dispatchRequest(config) {
		throwIfCancellationRequested(config);
		config.headers = AxiosHeaders.from(config.headers);
		config.data = transformData.call(config, config.transformRequest);
		if ([
			"post",
			"put",
			"patch"
		].indexOf(config.method) !== -1) config.headers.setContentType("application/x-www-form-urlencoded", false);
		return adapters.getAdapter(config.adapter || defaults.adapter, config)(config).then(function onAdapterResolution(response) {
			throwIfCancellationRequested(config);
			config.response = response;
			try {
				response.data = transformData.call(config, config.transformResponse, response);
			} finally {
				delete config.response;
			}
			response.headers = AxiosHeaders.from(response.headers);
			return response;
		}, function onAdapterRejection(reason) {
			if (!isCancel(reason)) {
				throwIfCancellationRequested(config);
				if (reason && reason.response) {
					config.response = reason.response;
					try {
						reason.response.data = transformData.call(config, config.transformResponse, reason.response);
					} finally {
						delete config.response;
					}
					reason.response.headers = AxiosHeaders.from(reason.response.headers);
				}
			}
			return Promise.reject(reason);
		});
	}
	const validators$1 = {};
	[
		"object",
		"boolean",
		"number",
		"function",
		"string",
		"symbol"
	].forEach((type, i) => {
		validators$1[type] = function validator(thing) {
			return typeof thing === type || "a" + (i < 1 ? "n " : " ") + type;
		};
	});
	const deprecatedWarnings = {};
	/**
	* Transitional option validator
	*
	* @param {function|boolean?} validator - set to false if the transitional option has been removed
	* @param {string?} version - deprecated version / removed since version
	* @param {string?} message - some message with additional info
	*
	* @returns {function}
	*/
	validators$1.transitional = function transitional(validator, version, message) {
		function formatMessage(opt, desc) {
			return "[Axios v1.16.0] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
		}
		return (value, opt, opts) => {
			if (validator === false) throw new AxiosError(formatMessage(opt, " has been removed" + (version ? " in " + version : "")), AxiosError.ERR_DEPRECATED);
			if (version && !deprecatedWarnings[opt]) {
				deprecatedWarnings[opt] = true;
				console.warn(formatMessage(opt, " has been deprecated since v" + version + " and will be removed in the near future"));
			}
			return validator ? validator(value, opt, opts) : true;
		};
	};
	validators$1.spelling = function spelling(correctSpelling) {
		return (value, opt) => {
			console.warn(`${opt} is likely a misspelling of ${correctSpelling}`);
			return true;
		};
	};
	/**
	* Assert object's properties type
	*
	* @param {object} options
	* @param {object} schema
	* @param {boolean?} allowUnknown
	*
	* @returns {object}
	*/
	function assertOptions(options, schema, allowUnknown) {
		if (typeof options !== "object") throw new AxiosError("options must be an object", AxiosError.ERR_BAD_OPTION_VALUE);
		const keys = Object.keys(options);
		let i = keys.length;
		while (i-- > 0) {
			const opt = keys[i];
			const validator = Object.prototype.hasOwnProperty.call(schema, opt) ? schema[opt] : void 0;
			if (validator) {
				const value = options[opt];
				const result = value === void 0 || validator(value, opt, options);
				if (result !== true) throw new AxiosError("option " + opt + " must be " + result, AxiosError.ERR_BAD_OPTION_VALUE);
				continue;
			}
			if (allowUnknown !== true) throw new AxiosError("Unknown option " + opt, AxiosError.ERR_BAD_OPTION);
		}
	}
	var validator = {
		assertOptions,
		validators: validators$1
	};
	const validators = validator.validators;
	/**
	* Create a new instance of Axios
	*
	* @param {Object} instanceConfig The default config for the instance
	*
	* @return {Axios} A new instance of Axios
	*/
	var Axios = class {
		constructor(instanceConfig) {
			this.defaults = instanceConfig || {};
			this.interceptors = {
				request: new InterceptorManager(),
				response: new InterceptorManager()
			};
		}
		/**
		* Dispatch a request
		*
		* @param {String|Object} configOrUrl The config specific for this request (merged with this.defaults)
		* @param {?Object} config
		*
		* @returns {Promise} The Promise to be fulfilled
		*/
		async request(configOrUrl, config) {
			try {
				return await this._request(configOrUrl, config);
			} catch (err) {
				if (err instanceof Error) {
					let dummy = {};
					Error.captureStackTrace ? Error.captureStackTrace(dummy) : dummy = /* @__PURE__ */ new Error();
					const stack = (() => {
						if (!dummy.stack) return "";
						const firstNewlineIndex = dummy.stack.indexOf("\n");
						return firstNewlineIndex === -1 ? "" : dummy.stack.slice(firstNewlineIndex + 1);
					})();
					try {
						if (!err.stack) err.stack = stack;
						else if (stack) {
							const firstNewlineIndex = stack.indexOf("\n");
							const secondNewlineIndex = firstNewlineIndex === -1 ? -1 : stack.indexOf("\n", firstNewlineIndex + 1);
							const stackWithoutTwoTopLines = secondNewlineIndex === -1 ? "" : stack.slice(secondNewlineIndex + 1);
							if (!String(err.stack).endsWith(stackWithoutTwoTopLines)) err.stack += "\n" + stack;
						}
					} catch (e) {}
				}
				throw err;
			}
		}
		_request(configOrUrl, config) {
			if (typeof configOrUrl === "string") {
				config = config || {};
				config.url = configOrUrl;
			} else config = configOrUrl || {};
			config = mergeConfig(this.defaults, config);
			const { transitional, paramsSerializer, headers } = config;
			if (transitional !== void 0) validator.assertOptions(transitional, {
				silentJSONParsing: validators.transitional(validators.boolean),
				forcedJSONParsing: validators.transitional(validators.boolean),
				clarifyTimeoutError: validators.transitional(validators.boolean),
				legacyInterceptorReqResOrdering: validators.transitional(validators.boolean)
			}, false);
			if (paramsSerializer != null) if (utils$1.isFunction(paramsSerializer)) config.paramsSerializer = { serialize: paramsSerializer };
			else validator.assertOptions(paramsSerializer, {
				encode: validators.function,
				serialize: validators.function
			}, true);
			if (config.allowAbsoluteUrls !== void 0);
			else if (this.defaults.allowAbsoluteUrls !== void 0) config.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls;
			else config.allowAbsoluteUrls = true;
			validator.assertOptions(config, {
				baseUrl: validators.spelling("baseURL"),
				withXsrfToken: validators.spelling("withXSRFToken")
			}, true);
			config.method = (config.method || this.defaults.method || "get").toLowerCase();
			let contextHeaders = headers && utils$1.merge(headers.common, headers[config.method]);
			headers && utils$1.forEach([
				"delete",
				"get",
				"head",
				"post",
				"put",
				"patch",
				"query",
				"common"
			], (method) => {
				delete headers[method];
			});
			config.headers = AxiosHeaders.concat(contextHeaders, headers);
			const requestInterceptorChain = [];
			let synchronousRequestInterceptors = true;
			this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
				if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) return;
				synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
				const transitional = config.transitional || transitionalDefaults;
				if (transitional && transitional.legacyInterceptorReqResOrdering) requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
				else requestInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
			});
			const responseInterceptorChain = [];
			this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
				responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
			});
			let promise;
			let i = 0;
			let len;
			if (!synchronousRequestInterceptors) {
				const chain = [dispatchRequest.bind(this), void 0];
				chain.unshift(...requestInterceptorChain);
				chain.push(...responseInterceptorChain);
				len = chain.length;
				promise = Promise.resolve(config);
				while (i < len) promise = promise.then(chain[i++], chain[i++]);
				return promise;
			}
			len = requestInterceptorChain.length;
			let newConfig = config;
			while (i < len) {
				const onFulfilled = requestInterceptorChain[i++];
				const onRejected = requestInterceptorChain[i++];
				try {
					newConfig = onFulfilled(newConfig);
				} catch (error) {
					onRejected.call(this, error);
					break;
				}
			}
			try {
				promise = dispatchRequest.call(this, newConfig);
			} catch (error) {
				return Promise.reject(error);
			}
			i = 0;
			len = responseInterceptorChain.length;
			while (i < len) promise = promise.then(responseInterceptorChain[i++], responseInterceptorChain[i++]);
			return promise;
		}
		getUri(config) {
			config = mergeConfig(this.defaults, config);
			return buildURL(buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls), config.params, config.paramsSerializer);
		}
	};
	utils$1.forEach([
		"delete",
		"get",
		"head",
		"options"
	], function forEachMethodNoData(method) {
		Axios.prototype[method] = function(url, config) {
			return this.request(mergeConfig(config || {}, {
				method,
				url,
				data: (config || {}).data
			}));
		};
	});
	utils$1.forEach([
		"post",
		"put",
		"patch",
		"query"
	], function forEachMethodWithData(method) {
		function generateHTTPMethod(isForm) {
			return function httpMethod(url, data, config) {
				return this.request(mergeConfig(config || {}, {
					method,
					headers: isForm ? { "Content-Type": "multipart/form-data" } : {},
					url,
					data
				}));
			};
		}
		Axios.prototype[method] = generateHTTPMethod();
		if (method !== "query") Axios.prototype[method + "Form"] = generateHTTPMethod(true);
	});
	/**
	* A `CancelToken` is an object that can be used to request cancellation of an operation.
	*
	* @param {Function} executor The executor function.
	*
	* @returns {CancelToken}
	*/
	var CancelToken = class CancelToken {
		constructor(executor) {
			if (typeof executor !== "function") throw new TypeError("executor must be a function.");
			let resolvePromise;
			this.promise = new Promise(function promiseExecutor(resolve) {
				resolvePromise = resolve;
			});
			const token = this;
			this.promise.then((cancel) => {
				if (!token._listeners) return;
				let i = token._listeners.length;
				while (i-- > 0) token._listeners[i](cancel);
				token._listeners = null;
			});
			this.promise.then = (onfulfilled) => {
				let _resolve;
				const promise = new Promise((resolve) => {
					token.subscribe(resolve);
					_resolve = resolve;
				}).then(onfulfilled);
				promise.cancel = function reject() {
					token.unsubscribe(_resolve);
				};
				return promise;
			};
			executor(function cancel(message, config, request) {
				if (token.reason) return;
				token.reason = new CanceledError(message, config, request);
				resolvePromise(token.reason);
			});
		}
		/**
		* Throws a `CanceledError` if cancellation has been requested.
		*/
		throwIfRequested() {
			if (this.reason) throw this.reason;
		}
		/**
		* Subscribe to the cancel signal
		*/
		subscribe(listener) {
			if (this.reason) {
				listener(this.reason);
				return;
			}
			if (this._listeners) this._listeners.push(listener);
			else this._listeners = [listener];
		}
		/**
		* Unsubscribe from the cancel signal
		*/
		unsubscribe(listener) {
			if (!this._listeners) return;
			const index = this._listeners.indexOf(listener);
			if (index !== -1) this._listeners.splice(index, 1);
		}
		toAbortSignal() {
			const controller = new AbortController();
			const abort = (err) => {
				controller.abort(err);
			};
			this.subscribe(abort);
			controller.signal.unsubscribe = () => this.unsubscribe(abort);
			return controller.signal;
		}
		/**
		* Returns an object that contains a new `CancelToken` and a function that, when called,
		* cancels the `CancelToken`.
		*/
		static source() {
			let cancel;
			return {
				token: new CancelToken(function executor(c) {
					cancel = c;
				}),
				cancel
			};
		}
	};
	/**
	* Syntactic sugar for invoking a function and expanding an array for arguments.
	*
	* Common use case would be to use `Function.prototype.apply`.
	*
	*  ```js
	*  function f(x, y, z) {}
	*  const args = [1, 2, 3];
	*  f.apply(null, args);
	*  ```
	*
	* With `spread` this example can be re-written.
	*
	*  ```js
	*  spread(function(x, y, z) {})([1, 2, 3]);
	*  ```
	*
	* @param {Function} callback
	*
	* @returns {Function}
	*/
	function spread(callback) {
		return function wrap(arr) {
			return callback.apply(null, arr);
		};
	}
	/**
	* Determines whether the payload is an error thrown by Axios
	*
	* @param {*} payload The value to test
	*
	* @returns {boolean} True if the payload is an error thrown by Axios, otherwise false
	*/
	function isAxiosError(payload) {
		return utils$1.isObject(payload) && payload.isAxiosError === true;
	}
	const HttpStatusCode = {
		Continue: 100,
		SwitchingProtocols: 101,
		Processing: 102,
		EarlyHints: 103,
		Ok: 200,
		Created: 201,
		Accepted: 202,
		NonAuthoritativeInformation: 203,
		NoContent: 204,
		ResetContent: 205,
		PartialContent: 206,
		MultiStatus: 207,
		AlreadyReported: 208,
		ImUsed: 226,
		MultipleChoices: 300,
		MovedPermanently: 301,
		Found: 302,
		SeeOther: 303,
		NotModified: 304,
		UseProxy: 305,
		Unused: 306,
		TemporaryRedirect: 307,
		PermanentRedirect: 308,
		BadRequest: 400,
		Unauthorized: 401,
		PaymentRequired: 402,
		Forbidden: 403,
		NotFound: 404,
		MethodNotAllowed: 405,
		NotAcceptable: 406,
		ProxyAuthenticationRequired: 407,
		RequestTimeout: 408,
		Conflict: 409,
		Gone: 410,
		LengthRequired: 411,
		PreconditionFailed: 412,
		PayloadTooLarge: 413,
		UriTooLong: 414,
		UnsupportedMediaType: 415,
		RangeNotSatisfiable: 416,
		ExpectationFailed: 417,
		ImATeapot: 418,
		MisdirectedRequest: 421,
		UnprocessableEntity: 422,
		Locked: 423,
		FailedDependency: 424,
		TooEarly: 425,
		UpgradeRequired: 426,
		PreconditionRequired: 428,
		TooManyRequests: 429,
		RequestHeaderFieldsTooLarge: 431,
		UnavailableForLegalReasons: 451,
		InternalServerError: 500,
		NotImplemented: 501,
		BadGateway: 502,
		ServiceUnavailable: 503,
		GatewayTimeout: 504,
		HttpVersionNotSupported: 505,
		VariantAlsoNegotiates: 506,
		InsufficientStorage: 507,
		LoopDetected: 508,
		NotExtended: 510,
		NetworkAuthenticationRequired: 511,
		WebServerIsDown: 521,
		ConnectionTimedOut: 522,
		OriginIsUnreachable: 523,
		TimeoutOccurred: 524,
		SslHandshakeFailed: 525,
		InvalidSslCertificate: 526
	};
	Object.entries(HttpStatusCode).forEach(([key, value]) => {
		HttpStatusCode[value] = key;
	});
	/**
	* Create an instance of Axios
	*
	* @param {Object} defaultConfig The default config for the instance
	*
	* @returns {Axios} A new instance of Axios
	*/
	function createInstance(defaultConfig) {
		const context = new Axios(defaultConfig);
		const instance = bind(Axios.prototype.request, context);
		utils$1.extend(instance, Axios.prototype, context, { allOwnKeys: true });
		utils$1.extend(instance, context, null, { allOwnKeys: true });
		instance.create = function create(instanceConfig) {
			return createInstance(mergeConfig(defaultConfig, instanceConfig));
		};
		return instance;
	}
	const axios = createInstance(defaults);
	axios.Axios = Axios;
	axios.CanceledError = CanceledError;
	axios.CancelToken = CancelToken;
	axios.isCancel = isCancel;
	axios.VERSION = VERSION;
	axios.toFormData = toFormData;
	axios.AxiosError = AxiosError;
	axios.Cancel = axios.CanceledError;
	axios.all = function all(promises) {
		return Promise.all(promises);
	};
	axios.spread = spread;
	axios.isAxiosError = isAxiosError;
	axios.mergeConfig = mergeConfig;
	axios.AxiosHeaders = AxiosHeaders;
	axios.formToJSON = (thing) => formDataToJSON(utils$1.isHTMLForm(thing) ? new FormData(thing) : thing);
	axios.getAdapter = adapters.getAdapter;
	axios.HttpStatusCode = HttpStatusCode;
	axios.default = axios;
	module.exports = axios;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/ansi.js
var require_ansi = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ANSI = /* @__PURE__ */ ((ANSI2) => {
		ANSI2["Reset"] = "\x1B[0m";
		ANSI2["Bold"] = "\x1B[1m";
		ANSI2["BoldReset"] = "\x1B[22m";
		ANSI2["Italic"] = "\x1B[3m";
		ANSI2["ItalicReset"] = "\x1B[23m";
		ANSI2["Underline"] = "\x1B[4m";
		ANSI2["UnderlineReset"] = "\x1B[24m";
		ANSI2["Strike"] = "\x1B[9m";
		ANSI2["StrikeReset"] = "\x1B[29m";
		ANSI2["ForegroundReset"] = "\x1B[0m";
		ANSI2["BackgroundReset"] = "\x1B[0m";
		ANSI2["ForegroundBlack"] = "\x1B[30m";
		ANSI2["BackgroundBlack"] = "\x1B[40m";
		ANSI2["ForegroundRed"] = "\x1B[31m";
		ANSI2["BackgroundRed"] = "\x1B[41m";
		ANSI2["ForegroundGreen"] = "\x1B[32m";
		ANSI2["BackgroundGreen"] = "\x1B[42m";
		ANSI2["ForegroundYellow"] = "\x1B[33m";
		ANSI2["BackgroundYellow"] = "\x1B[43m";
		ANSI2["ForegroundBlue"] = "\x1B[34m";
		ANSI2["BackgroundBlue"] = "\x1B[44m";
		ANSI2["ForegroundMagenta"] = "\x1B[35m";
		ANSI2["BackgroundMagenta"] = "\x1B[45m";
		ANSI2["ForegroundCyan"] = "\x1B[36m";
		ANSI2["BackgroundCyan"] = "\x1B[46m";
		ANSI2["ForegroundWhite"] = "\x1B[37m";
		ANSI2["BackgroundWhite"] = "\x1B[47m";
		ANSI2["ForegroundGray"] = "\x1B[90m";
		ANSI2["ForegroundDefault"] = "\x1B[39m";
		ANSI2["BackgroundDefault"] = "\x1B[49m";
		return ANSI2;
	})(ANSI || {});
	exports.ANSI = ANSI;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/console.js
var require_console = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ansi = require_ansi();
	var ConsoleLogger = class ConsoleLogger {
		loggerOptions;
		name;
		level;
		_enabled;
		_levels = {
			error: 100,
			warn: 200,
			info: 300,
			debug: 400,
			trace: 500
		};
		_colors = {
			error: ansi.ANSI.ForegroundRed,
			warn: ansi.ANSI.ForegroundYellow,
			info: ansi.ANSI.ForegroundCyan,
			debug: ansi.ANSI.ForegroundMagenta,
			trace: ansi.ANSI.BackgroundBlue
		};
		constructor(name, options) {
			this.name = name;
			const env = typeof process === "undefined" ? void 0 : process.env;
			const logNamePattern = env?.LOG || options?.pattern || "*";
			this._enabled = parseMagicExpr(logNamePattern).test(name);
			this.level = parseLogLevel(env?.LOG_LEVEL) || options?.level || "info";
			this.loggerOptions = options ?? {
				level: this.level,
				pattern: logNamePattern
			};
		}
		error(...msg) {
			this.log("error", ...msg);
		}
		warn(...msg) {
			this.log("warn", ...msg);
		}
		info(...msg) {
			this.log("info", ...msg);
		}
		debug(...msg) {
			this.log("debug", ...msg);
		}
		trace(...msg) {
			this.log("trace", ...msg);
		}
		log(level, ...msg) {
			if (!this._enabled) return;
			if (this._levels[level] > this._levels[this.level]) return;
			const prefix = [
				this._colors[level],
				ansi.ANSI.Bold,
				`[${level.toUpperCase()}]`
			];
			const name = [
				this.name,
				ansi.ANSI.ForegroundReset,
				ansi.ANSI.BoldReset
			];
			for (const m of msg) {
				let text = new String(m);
				if (typeof m === "object") text = JSON.stringify(m, null, 2);
				for (const line of text.split("\n")) console[level](prefix.join(""), name.join(""), line);
			}
		}
		child(name, overrideOptions) {
			const mergedPattern = mergePatterns(this.loggerOptions.pattern, overrideOptions?.pattern);
			return new ConsoleLogger(`${this.name}/${name}`, {
				...this.loggerOptions,
				...overrideOptions,
				pattern: mergedPattern
			});
		}
	};
	function parsePatternString(pattern) {
		const patterns = pattern.split(",").map((p) => p.trim());
		const inclusions = [];
		const exclusions = [];
		for (const p of patterns) if (p.startsWith("-")) exclusions.push(p.substring(1));
		else inclusions.push(p);
		return {
			inclusions,
			exclusions
		};
	}
	function parseMagicExpr(pattern) {
		const { inclusions: inclusionPatterns, exclusions: exclusionPatterns } = parsePatternString(pattern);
		const inclusions = inclusionPatterns.map((p) => patternToRegex(p));
		const exclusions = exclusionPatterns.map((p) => patternToRegex(p));
		if (inclusions.length === 0 && exclusions.length > 0) inclusions.push(/.*/);
		return { test: (name) => {
			if (!inclusions.some((regex) => regex.test(name))) return false;
			return !exclusions.some((regex) => regex.test(name));
		} };
	}
	function patternToRegex(pattern) {
		let res = "";
		const parts = pattern.split("*");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) res += ".*";
			res += parts[i];
		}
		return new RegExp(res);
	}
	function mergePatterns(parentPattern, childPattern) {
		if (!parentPattern && !childPattern) return "*";
		if (!parentPattern) return childPattern;
		if (!childPattern) return parentPattern;
		const parent = parsePatternString(parentPattern);
		const child = parsePatternString(childPattern);
		let allInclusions = [.../* @__PURE__ */ new Set([...parent.inclusions, ...child.inclusions])];
		if (allInclusions.length === 0) allInclusions = ["*"];
		const optimizedInclusions = allInclusions.includes("*") ? ["*"] : allInclusions;
		const allExclusions = [.../* @__PURE__ */ new Set([...parent.exclusions, ...child.exclusions])];
		const inclusionStrings = optimizedInclusions;
		const exclusionStrings = allExclusions.map((e) => "-" + e);
		return [...inclusionStrings, ...exclusionStrings].join(",");
	}
	function parseLogLevel(level) {
		const value = level?.toLowerCase();
		switch (value) {
			case "error":
			case "warn":
			case "info":
			case "debug":
			case "trace": return value;
			default: return;
		}
	}
	exports.ConsoleLogger = ConsoleLogger;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/logger.js
var require_logger = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/string.js
var require_string = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ansi = require_ansi();
	var String = class {
		_value;
		constructor(value = "") {
			this._value = value;
		}
		clear() {
			this._value = "";
			return this;
		}
		append(...text) {
			this._value += text.join("");
			return this;
		}
		reset() {
			this._value += ansi.ANSI.Reset;
			return this;
		}
		bold(text) {
			this._value += ansi.ANSI.Bold + text.toString() + ansi.ANSI.BoldReset;
			return this;
		}
		italic(text) {
			this._value += ansi.ANSI.Italic + text.toString() + ansi.ANSI.ItalicReset;
			return this;
		}
		underline(text) {
			this._value += ansi.ANSI.Underline + text.toString() + ansi.ANSI.UnderlineReset;
			return this;
		}
		strike(text) {
			this._value += ansi.ANSI.Strike + text.toString() + ansi.ANSI.StrikeReset;
			return this;
		}
		black(text) {
			this._value += ansi.ANSI.ForegroundBlack + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgBlack(text) {
			this._value += ansi.ANSI.BackgroundBlack + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		red(text) {
			this._value += ansi.ANSI.ForegroundRed + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgRed(text) {
			this._value += ansi.ANSI.BackgroundRed + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		green(text) {
			this._value += ansi.ANSI.ForegroundGreen + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgGreen(text) {
			this._value += ansi.ANSI.BackgroundGreen + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		yellow(text) {
			this._value += ansi.ANSI.ForegroundYellow + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgYellow(text) {
			this._value += ansi.ANSI.BackgroundYellow + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		blue(text) {
			this._value += ansi.ANSI.ForegroundBlue + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgBlue(text) {
			this._value += ansi.ANSI.BackgroundBlue + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		magenta(text) {
			this._value += ansi.ANSI.ForegroundMagenta + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgMagenta(text) {
			this._value += ansi.ANSI.BackgroundMagenta + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		cyan(text) {
			this._value += ansi.ANSI.ForegroundCyan + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgCyan(text) {
			this._value += ansi.ANSI.BackgroundCyan + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		white(text) {
			this._value += ansi.ANSI.ForegroundWhite + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgWhite(text) {
			this._value += ansi.ANSI.BackgroundWhite + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		gray(text) {
			this._value += ansi.ANSI.ForegroundGray + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		default(text) {
			this._value += ansi.ANSI.ForegroundDefault + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgDefault(text) {
			this._value += ansi.ANSI.BackgroundDefault + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		toString() {
			return this._value;
		}
	};
	exports.String = String;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/index.js
var require_logging = /* @__PURE__ */ __commonJSMin(((exports) => {
	var console = require_console();
	var logger = require_logger();
	var string = require_string();
	Object.keys(console).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return console[k];
			}
		});
	});
	Object.keys(logger).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return logger[k];
			}
		});
	});
	Object.keys(string).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return string[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/client.js
var require_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	var axios = require_axios();
	var logging = require_logging();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var axios__default = /* @__PURE__ */ _interopDefault(axios);
	exports.Client = class Client {
		token;
		name;
		options;
		log;
		http;
		seq = 0;
		interceptors;
		constructor(options = {}) {
			this.options = options;
			this.name = options.name || "http";
			this.token = options.token;
			this.log = options.logger || new logging.ConsoleLogger(this.name);
			this.interceptors = /* @__PURE__ */ new Map();
			this.http = axios__default.default.create({
				baseURL: options.baseUrl,
				timeout: options.timeout,
				headers: options.headers
			});
			for (const interceptor of options.interceptors || []) this.use(interceptor);
		}
		async get(url, config) {
			return this.http.get(url, await this.withConfig(config));
		}
		async post(url, data, config) {
			return this.http.post(url, data, await this.withConfig(config));
		}
		async put(url, data, config) {
			return this.http.put(url, data, await this.withConfig(config));
		}
		async patch(url, data, config) {
			return this.http.patch(url, data, await this.withConfig(config));
		}
		async delete(url, config) {
			return this.http.delete(url, await this.withConfig(config));
		}
		async request(config) {
			return this.http.request(await this.withConfig(config));
		}
		/**
		* Register an interceptor to use
		* as middleware for the request/response/error
		*/
		use(interceptor) {
			const id = ++this.seq;
			let requestId = void 0;
			let responseId = void 0;
			if (interceptor.request) requestId = this.http.interceptors.request.use(
				/* istanbul ignore next */
				(config) => {
					return interceptor.request({
						config,
						log: this.log
					});
				},
				/* istanbul ignore next */
				(error) => {
					if (!interceptor.error) return error;
					return interceptor.error({
						error,
						log: this.log
					});
				}
			);
			if (interceptor.response) responseId = this.http.interceptors.response.use(
				/* istanbul ignore next */
				(res) => {
					return interceptor.response({
						res,
						log: this.log
					});
				},
				/* istanbul ignore next */
				(error) => {
					if (!interceptor.error) return error;
					return interceptor.error({
						error,
						log: this.log
					});
				}
			);
			this.interceptors.set(id, {
				requestId,
				responseId,
				interceptor
			});
			return id;
		}
		/**
		* Eject an interceptor
		*/
		eject(id) {
			const registry = this.interceptors.get(id);
			if (!registry) return;
			if (registry.requestId) this.http.interceptors.request.eject(registry.requestId);
			if (registry.responseId) this.http.interceptors.response.eject(registry.responseId);
			this.interceptors.delete(id);
		}
		/**
		* Clear (Eject) all interceptors
		*/
		clear() {
			for (const id of this.interceptors.keys()) this.eject(id);
		}
		/**
		* Create a copy of the client
		*/
		clone(options) {
			const findUA = (h) => {
				if (!h) return void 0;
				const key = Object.keys(h).find((k) => k.toLowerCase() === "user-agent");
				return key ? String(h[key]) : void 0;
			};
			const parentUA = findUA(this.options.headers);
			const childUA = findUA(options?.headers);
			const mergedUA = parentUA && childUA ? `${childUA} ${parentUA}` : childUA || parentUA;
			const headers = {
				...this.options.headers,
				...options?.headers
			};
			if (mergedUA) {
				for (const key of Object.keys(headers)) if (key.toLowerCase() === "user-agent") delete headers[key];
				headers["User-Agent"] = mergedUA;
			}
			return new Client({
				...this.options,
				...options,
				headers,
				interceptors: [...Array.from(this.interceptors.values()).map((i) => i.interceptor)]
			});
		}
		async withConfig(config = {}) {
			let token = config.token || this.token;
			if (config.token) delete config.token;
			if (this.options.headers) {
				if (!config.headers) config.headers = {};
				for (const key in this.options.headers) config.headers[key] = this.options.headers[key];
			}
			if (token) {
				if (!config.headers) config.headers = {};
				if (typeof token === "function") token = await token(config);
				if (token && typeof token === "object") token = token.toString();
				config.headers["Authorization"] = `Bearer ${token}`;
			}
			return config;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/interceptor.js
var require_interceptor = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/token.js
var require_token$3 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/index.js
var require_http = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = require_client();
	var interceptor = require_interceptor();
	var token = require_token$3();
	Object.keys(client).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return client[k];
			}
		});
	});
	Object.keys(interceptor).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return interceptor[k];
			}
		});
	});
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/storage/list-local-storage.js
var require_list_local_storage = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ListLocalStorage = class {
		_list;
		constructor(data = []) {
			this._list = [...data];
		}
		get(key) {
			return this._list[key];
		}
		set(key, value) {
			this._list[key] = value;
		}
		delete(key) {
			this._list.splice(key, 1);
		}
		push(value) {
			this._list.push(value);
		}
		pop() {
			return this._list.pop();
		}
		values() {
			return [...this._list];
		}
		length() {
			return this._list.length;
		}
		where(predicate) {
			return this._list.filter(predicate);
		}
	};
	exports.ListLocalStorage = ListLocalStorage;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/storage/local-storage.js
var require_local_storage = /* @__PURE__ */ __commonJSMin(((exports) => {
	var LocalStorage = class {
		_store;
		_keys;
		_options;
		get keys() {
			return this._keys;
		}
		get size() {
			return this._store.size;
		}
		constructor(data = {}, options = {}) {
			this._store = new Map(Object.entries(data));
			this._keys = Object.keys(data);
			this._options = options;
		}
		get(key) {
			this._hit(key);
			return this._store.get(key);
		}
		set(key, value) {
			if (!this._hit(key)) this._keys.push(key);
			if (this._options.max) {
				if (this._keys.length > this._options.max) {
					const k = this._keys.shift();
					if (k) this._store.delete(k);
				}
			}
			this._store.set(key, value);
		}
		delete(key) {
			const i = this._keys.findIndex((k) => key === k);
			if (i > -1) this._keys.splice(i, 1);
			this._store.delete(key);
		}
		toString() {
			return JSON.stringify(Array.from(this._store.entries()).map(([key, value]) => ({
				key,
				value
			})), null, 2);
		}
		_hit(key) {
			if (!this._store.has(key)) return false;
			if (this._keys[this._keys.length - 1] === key) return true;
			const idx = this._keys.findIndex((k) => key === k);
			if (idx < 0) return false;
			for (let i = idx + 1; i < this._keys.length; i++) {
				const tmp = this._keys[i - 1];
				this._keys[i - 1] = this._keys[i];
				this._keys[i] = tmp;
			}
			return true;
		}
	};
	exports.LocalStorage = LocalStorage;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/storage/storage.js
var require_storage$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/storage/index.js
var require_storage = /* @__PURE__ */ __commonJSMin(((exports) => {
	var listLocalStorage = require_list_local_storage();
	var localStorage = require_local_storage();
	var storage = require_storage$1();
	Object.keys(listLocalStorage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return listLocalStorage[k];
			}
		});
	});
	Object.keys(localStorage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return localStorage[k];
			}
		});
	});
	Object.keys(storage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return storage[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/index.js
var require_dist$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var events = require_events();
	var http = require_http();
	var logging = require_logging();
	var storage = require_storage();
	Object.keys(events).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return events[k];
			}
		});
	});
	Object.keys(http).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return http[k];
			}
		});
	});
	Object.keys(logging).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return logging[k];
			}
		});
	});
	Object.keys(storage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return storage[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/api-client-settings.js
var require_api_client_settings = /* @__PURE__ */ __commonJSMin(((exports) => {
	const DEFAULT_API_CLIENT_SETTINGS = { oauthUrl: "https://token.botframework.com" };
	function mergeApiClientSettings(apiClientSettings, cloud) {
		const env = typeof process === "undefined" ? void 0 : process.env;
		const defaultOauthUrl = cloud?.tokenServiceUrl ?? DEFAULT_API_CLIENT_SETTINGS.oauthUrl;
		return { oauthUrl: apiClientSettings?.oauthUrl ?? env?.OAUTH_URL ?? defaultOauthUrl };
	}
	exports.DEFAULT_API_CLIENT_SETTINGS = DEFAULT_API_CLIENT_SETTINGS;
	exports.mergeApiClientSettings = mergeApiClientSettings;
}));
//#endregion
//#region node_modules/object-inspect/util.inspect.js
var require_util_inspect = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = __require("util").inspect;
}));
//#endregion
//#region node_modules/object-inspect/index.js
var require_object_inspect = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var hasMap = typeof Map === "function" && Map.prototype;
	var mapSizeDescriptor = Object.getOwnPropertyDescriptor && hasMap ? Object.getOwnPropertyDescriptor(Map.prototype, "size") : null;
	var mapSize = hasMap && mapSizeDescriptor && typeof mapSizeDescriptor.get === "function" ? mapSizeDescriptor.get : null;
	var mapForEach = hasMap && Map.prototype.forEach;
	var hasSet = typeof Set === "function" && Set.prototype;
	var setSizeDescriptor = Object.getOwnPropertyDescriptor && hasSet ? Object.getOwnPropertyDescriptor(Set.prototype, "size") : null;
	var setSize = hasSet && setSizeDescriptor && typeof setSizeDescriptor.get === "function" ? setSizeDescriptor.get : null;
	var setForEach = hasSet && Set.prototype.forEach;
	var weakMapHas = typeof WeakMap === "function" && WeakMap.prototype ? WeakMap.prototype.has : null;
	var weakSetHas = typeof WeakSet === "function" && WeakSet.prototype ? WeakSet.prototype.has : null;
	var weakRefDeref = typeof WeakRef === "function" && WeakRef.prototype ? WeakRef.prototype.deref : null;
	var booleanValueOf = Boolean.prototype.valueOf;
	var objectToString = Object.prototype.toString;
	var functionToString = Function.prototype.toString;
	var $match = String.prototype.match;
	var $slice = String.prototype.slice;
	var $replace = String.prototype.replace;
	var $toUpperCase = String.prototype.toUpperCase;
	var $toLowerCase = String.prototype.toLowerCase;
	var $test = RegExp.prototype.test;
	var $concat = Array.prototype.concat;
	var $join = Array.prototype.join;
	var $arrSlice = Array.prototype.slice;
	var $floor = Math.floor;
	var bigIntValueOf = typeof BigInt === "function" ? BigInt.prototype.valueOf : null;
	var gOPS = Object.getOwnPropertySymbols;
	var symToString = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? Symbol.prototype.toString : null;
	var hasShammedSymbols = typeof Symbol === "function" && typeof Symbol.iterator === "object";
	var toStringTag = typeof Symbol === "function" && Symbol.toStringTag && (typeof Symbol.toStringTag === hasShammedSymbols ? "object" : "symbol") ? Symbol.toStringTag : null;
	var isEnumerable = Object.prototype.propertyIsEnumerable;
	var gPO = (typeof Reflect === "function" ? Reflect.getPrototypeOf : Object.getPrototypeOf) || ([].__proto__ === Array.prototype ? function(O) {
		return O.__proto__;
	} : null);
	function addNumericSeparator(num, str) {
		if (num === Infinity || num === -Infinity || num !== num || num && num > -1e3 && num < 1e3 || $test.call(/e/, str)) return str;
		var sepRegex = /[0-9](?=(?:[0-9]{3})+(?![0-9]))/g;
		if (typeof num === "number") {
			var int = num < 0 ? -$floor(-num) : $floor(num);
			if (int !== num) {
				var intStr = String(int);
				var dec = $slice.call(str, intStr.length + 1);
				return $replace.call(intStr, sepRegex, "$&_") + "." + $replace.call($replace.call(dec, /([0-9]{3})/g, "$&_"), /_$/, "");
			}
		}
		return $replace.call(str, sepRegex, "$&_");
	}
	var utilInspect = require_util_inspect();
	var inspectCustom = utilInspect.custom;
	var inspectSymbol = isSymbol(inspectCustom) ? inspectCustom : null;
	var quotes = {
		__proto__: null,
		"double": "\"",
		single: "'"
	};
	var quoteREs = {
		__proto__: null,
		"double": /(["\\])/g,
		single: /(['\\])/g
	};
	module.exports = function inspect_(obj, options, depth, seen) {
		var opts = options || {};
		if (has(opts, "quoteStyle") && !has(quotes, opts.quoteStyle)) throw new TypeError("option \"quoteStyle\" must be \"single\" or \"double\"");
		if (has(opts, "maxStringLength") && (typeof opts.maxStringLength === "number" ? opts.maxStringLength < 0 && opts.maxStringLength !== Infinity : opts.maxStringLength !== null)) throw new TypeError("option \"maxStringLength\", if provided, must be a positive integer, Infinity, or `null`");
		var customInspect = has(opts, "customInspect") ? opts.customInspect : true;
		if (typeof customInspect !== "boolean" && customInspect !== "symbol") throw new TypeError("option \"customInspect\", if provided, must be `true`, `false`, or `'symbol'`");
		if (has(opts, "indent") && opts.indent !== null && opts.indent !== "	" && !(parseInt(opts.indent, 10) === opts.indent && opts.indent > 0)) throw new TypeError("option \"indent\" must be \"\\t\", an integer > 0, or `null`");
		if (has(opts, "numericSeparator") && typeof opts.numericSeparator !== "boolean") throw new TypeError("option \"numericSeparator\", if provided, must be `true` or `false`");
		var numericSeparator = opts.numericSeparator;
		if (typeof obj === "undefined") return "undefined";
		if (obj === null) return "null";
		if (typeof obj === "boolean") return obj ? "true" : "false";
		if (typeof obj === "string") return inspectString(obj, opts);
		if (typeof obj === "number") {
			if (obj === 0) return Infinity / obj > 0 ? "0" : "-0";
			var str = String(obj);
			return numericSeparator ? addNumericSeparator(obj, str) : str;
		}
		if (typeof obj === "bigint") {
			var bigIntStr = String(obj) + "n";
			return numericSeparator ? addNumericSeparator(obj, bigIntStr) : bigIntStr;
		}
		var maxDepth = typeof opts.depth === "undefined" ? 5 : opts.depth;
		if (typeof depth === "undefined") depth = 0;
		if (depth >= maxDepth && maxDepth > 0 && typeof obj === "object") return isArray(obj) ? "[Array]" : "[Object]";
		var indent = getIndent(opts, depth);
		if (typeof seen === "undefined") seen = [];
		else if (indexOf(seen, obj) >= 0) return "[Circular]";
		function inspect(value, from, noIndent) {
			if (from) {
				seen = $arrSlice.call(seen);
				seen.push(from);
			}
			if (noIndent) {
				var newOpts = { depth: opts.depth };
				if (has(opts, "quoteStyle")) newOpts.quoteStyle = opts.quoteStyle;
				return inspect_(value, newOpts, depth + 1, seen);
			}
			return inspect_(value, opts, depth + 1, seen);
		}
		if (typeof obj === "function" && !isRegExp(obj)) {
			var name = nameOf(obj);
			var keys = arrObjKeys(obj, inspect);
			return "[Function" + (name ? ": " + name : " (anonymous)") + "]" + (keys.length > 0 ? " { " + $join.call(keys, ", ") + " }" : "");
		}
		if (isSymbol(obj)) {
			var symString = hasShammedSymbols ? $replace.call(String(obj), /^(Symbol\(.*\))_[^)]*$/, "$1") : symToString.call(obj);
			return typeof obj === "object" && !hasShammedSymbols ? markBoxed(symString) : symString;
		}
		if (isElement(obj)) {
			var s = "<" + $toLowerCase.call(String(obj.nodeName));
			var attrs = obj.attributes || [];
			for (var i = 0; i < attrs.length; i++) s += " " + attrs[i].name + "=" + wrapQuotes(quote(attrs[i].value), "double", opts);
			s += ">";
			if (obj.childNodes && obj.childNodes.length) s += "...";
			s += "</" + $toLowerCase.call(String(obj.nodeName)) + ">";
			return s;
		}
		if (isArray(obj)) {
			if (obj.length === 0) return "[]";
			var xs = arrObjKeys(obj, inspect);
			if (indent && !singleLineValues(xs)) return "[" + indentedJoin(xs, indent) + "]";
			return "[ " + $join.call(xs, ", ") + " ]";
		}
		if (isError(obj)) {
			var parts = arrObjKeys(obj, inspect);
			if (!("cause" in Error.prototype) && "cause" in obj && !isEnumerable.call(obj, "cause")) return "{ [" + String(obj) + "] " + $join.call($concat.call("[cause]: " + inspect(obj.cause), parts), ", ") + " }";
			if (parts.length === 0) return "[" + String(obj) + "]";
			return "{ [" + String(obj) + "] " + $join.call(parts, ", ") + " }";
		}
		if (typeof obj === "object" && customInspect) {
			if (inspectSymbol && typeof obj[inspectSymbol] === "function" && utilInspect) return utilInspect(obj, { depth: maxDepth - depth });
			else if (customInspect !== "symbol" && typeof obj.inspect === "function") return obj.inspect();
		}
		if (isMap(obj)) {
			var mapParts = [];
			if (mapForEach) mapForEach.call(obj, function(value, key) {
				mapParts.push(inspect(key, obj, true) + " => " + inspect(value, obj));
			});
			return collectionOf("Map", mapSize.call(obj), mapParts, indent);
		}
		if (isSet(obj)) {
			var setParts = [];
			if (setForEach) setForEach.call(obj, function(value) {
				setParts.push(inspect(value, obj));
			});
			return collectionOf("Set", setSize.call(obj), setParts, indent);
		}
		if (isWeakMap(obj)) return weakCollectionOf("WeakMap");
		if (isWeakSet(obj)) return weakCollectionOf("WeakSet");
		if (isWeakRef(obj)) return weakCollectionOf("WeakRef");
		if (isNumber(obj)) return markBoxed(inspect(Number(obj)));
		if (isBigInt(obj)) return markBoxed(inspect(bigIntValueOf.call(obj)));
		if (isBoolean(obj)) return markBoxed(booleanValueOf.call(obj));
		if (isString(obj)) return markBoxed(inspect(String(obj)));
		if (typeof window !== "undefined" && obj === window) return "{ [object Window] }";
		if (typeof globalThis !== "undefined" && obj === globalThis || typeof global !== "undefined" && obj === global) return "{ [object globalThis] }";
		if (!isDate(obj) && !isRegExp(obj)) {
			var ys = arrObjKeys(obj, inspect);
			var isPlainObject = gPO ? gPO(obj) === Object.prototype : obj instanceof Object || obj.constructor === Object;
			var protoTag = obj instanceof Object ? "" : "null prototype";
			var stringTag = !isPlainObject && toStringTag && Object(obj) === obj && toStringTag in obj ? $slice.call(toStr(obj), 8, -1) : protoTag ? "Object" : "";
			var tag = (isPlainObject || typeof obj.constructor !== "function" ? "" : obj.constructor.name ? obj.constructor.name + " " : "") + (stringTag || protoTag ? "[" + $join.call($concat.call([], stringTag || [], protoTag || []), ": ") + "] " : "");
			if (ys.length === 0) return tag + "{}";
			if (indent) return tag + "{" + indentedJoin(ys, indent) + "}";
			return tag + "{ " + $join.call(ys, ", ") + " }";
		}
		return String(obj);
	};
	function wrapQuotes(s, defaultStyle, opts) {
		var quoteChar = quotes[opts.quoteStyle || defaultStyle];
		return quoteChar + s + quoteChar;
	}
	function quote(s) {
		return $replace.call(String(s), /"/g, "&quot;");
	}
	function canTrustToString(obj) {
		return !toStringTag || !(typeof obj === "object" && (toStringTag in obj || typeof obj[toStringTag] !== "undefined"));
	}
	function isArray(obj) {
		return toStr(obj) === "[object Array]" && canTrustToString(obj);
	}
	function isDate(obj) {
		return toStr(obj) === "[object Date]" && canTrustToString(obj);
	}
	function isRegExp(obj) {
		return toStr(obj) === "[object RegExp]" && canTrustToString(obj);
	}
	function isError(obj) {
		return toStr(obj) === "[object Error]" && canTrustToString(obj);
	}
	function isString(obj) {
		return toStr(obj) === "[object String]" && canTrustToString(obj);
	}
	function isNumber(obj) {
		return toStr(obj) === "[object Number]" && canTrustToString(obj);
	}
	function isBoolean(obj) {
		return toStr(obj) === "[object Boolean]" && canTrustToString(obj);
	}
	function isSymbol(obj) {
		if (hasShammedSymbols) return obj && typeof obj === "object" && obj instanceof Symbol;
		if (typeof obj === "symbol") return true;
		if (!obj || typeof obj !== "object" || !symToString) return false;
		try {
			symToString.call(obj);
			return true;
		} catch (e) {}
		return false;
	}
	function isBigInt(obj) {
		if (!obj || typeof obj !== "object" || !bigIntValueOf) return false;
		try {
			bigIntValueOf.call(obj);
			return true;
		} catch (e) {}
		return false;
	}
	var hasOwn = Object.prototype.hasOwnProperty || function(key) {
		return key in this;
	};
	function has(obj, key) {
		return hasOwn.call(obj, key);
	}
	function toStr(obj) {
		return objectToString.call(obj);
	}
	function nameOf(f) {
		if (f.name) return f.name;
		var m = $match.call(functionToString.call(f), /^function\s*([\w$]+)/);
		if (m) return m[1];
		return null;
	}
	function indexOf(xs, x) {
		if (xs.indexOf) return xs.indexOf(x);
		for (var i = 0, l = xs.length; i < l; i++) if (xs[i] === x) return i;
		return -1;
	}
	function isMap(x) {
		if (!mapSize || !x || typeof x !== "object") return false;
		try {
			mapSize.call(x);
			try {
				setSize.call(x);
			} catch (s) {
				return true;
			}
			return x instanceof Map;
		} catch (e) {}
		return false;
	}
	function isWeakMap(x) {
		if (!weakMapHas || !x || typeof x !== "object") return false;
		try {
			weakMapHas.call(x, weakMapHas);
			try {
				weakSetHas.call(x, weakSetHas);
			} catch (s) {
				return true;
			}
			return x instanceof WeakMap;
		} catch (e) {}
		return false;
	}
	function isWeakRef(x) {
		if (!weakRefDeref || !x || typeof x !== "object") return false;
		try {
			weakRefDeref.call(x);
			return true;
		} catch (e) {}
		return false;
	}
	function isSet(x) {
		if (!setSize || !x || typeof x !== "object") return false;
		try {
			setSize.call(x);
			try {
				mapSize.call(x);
			} catch (m) {
				return true;
			}
			return x instanceof Set;
		} catch (e) {}
		return false;
	}
	function isWeakSet(x) {
		if (!weakSetHas || !x || typeof x !== "object") return false;
		try {
			weakSetHas.call(x, weakSetHas);
			try {
				weakMapHas.call(x, weakMapHas);
			} catch (s) {
				return true;
			}
			return x instanceof WeakSet;
		} catch (e) {}
		return false;
	}
	function isElement(x) {
		if (!x || typeof x !== "object") return false;
		if (typeof HTMLElement !== "undefined" && x instanceof HTMLElement) return true;
		return typeof x.nodeName === "string" && typeof x.getAttribute === "function";
	}
	function inspectString(str, opts) {
		if (str.length > opts.maxStringLength) {
			var remaining = str.length - opts.maxStringLength;
			var trailer = "... " + remaining + " more character" + (remaining > 1 ? "s" : "");
			return inspectString($slice.call(str, 0, opts.maxStringLength), opts) + trailer;
		}
		var quoteRE = quoteREs[opts.quoteStyle || "single"];
		quoteRE.lastIndex = 0;
		return wrapQuotes($replace.call($replace.call(str, quoteRE, "\\$1"), /[\x00-\x1f]/g, lowbyte), "single", opts);
	}
	function lowbyte(c) {
		var n = c.charCodeAt(0);
		var x = {
			8: "b",
			9: "t",
			10: "n",
			12: "f",
			13: "r"
		}[n];
		if (x) return "\\" + x;
		return "\\x" + (n < 16 ? "0" : "") + $toUpperCase.call(n.toString(16));
	}
	function markBoxed(str) {
		return "Object(" + str + ")";
	}
	function weakCollectionOf(type) {
		return type + " { ? }";
	}
	function collectionOf(type, size, entries, indent) {
		var joinedEntries = indent ? indentedJoin(entries, indent) : $join.call(entries, ", ");
		return type + " (" + size + ") {" + joinedEntries + "}";
	}
	function singleLineValues(xs) {
		for (var i = 0; i < xs.length; i++) if (indexOf(xs[i], "\n") >= 0) return false;
		return true;
	}
	function getIndent(opts, depth) {
		var baseIndent;
		if (opts.indent === "	") baseIndent = "	";
		else if (typeof opts.indent === "number" && opts.indent > 0) baseIndent = $join.call(Array(opts.indent + 1), " ");
		else return null;
		return {
			base: baseIndent,
			prev: $join.call(Array(depth + 1), baseIndent)
		};
	}
	function indentedJoin(xs, indent) {
		if (xs.length === 0) return "";
		var lineJoiner = "\n" + indent.prev + indent.base;
		return lineJoiner + $join.call(xs, "," + lineJoiner) + "\n" + indent.prev;
	}
	function arrObjKeys(obj, inspect) {
		var isArr = isArray(obj);
		var xs = [];
		if (isArr) {
			xs.length = obj.length;
			for (var i = 0; i < obj.length; i++) xs[i] = has(obj, i) ? inspect(obj[i], obj) : "";
		}
		var syms = typeof gOPS === "function" ? gOPS(obj) : [];
		var symMap;
		if (hasShammedSymbols) {
			symMap = {};
			for (var k = 0; k < syms.length; k++) symMap["$" + syms[k]] = syms[k];
		}
		for (var key in obj) {
			if (!has(obj, key)) continue;
			if (isArr && String(Number(key)) === key && key < obj.length) continue;
			if (hasShammedSymbols && symMap["$" + key] instanceof Symbol) continue;
			else if ($test.call(/[^\w$]/, key)) xs.push(inspect(key, obj) + ": " + inspect(obj[key], obj));
			else xs.push(key + ": " + inspect(obj[key], obj));
		}
		if (typeof gOPS === "function") {
			for (var j = 0; j < syms.length; j++) if (isEnumerable.call(obj, syms[j])) xs.push("[" + inspect(syms[j]) + "]: " + inspect(obj[syms[j]], obj));
		}
		return xs;
	}
}));
//#endregion
//#region node_modules/side-channel-list/index.js
var require_side_channel_list = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var inspect = require_object_inspect();
	var $TypeError = require_type();
	/** @type {import('./list.d.ts').listGetNode} */
	var listGetNode = function(list, key, isDelete) {
		/** @type {typeof list | NonNullable<(typeof list)['next']>} */
		var prev = list;
		/** @type {(typeof list)['next']} */
		var curr;
		for (; (curr = prev.next) != null; prev = curr) if (curr.key === key) {
			prev.next = curr.next;
			if (!isDelete) {
				curr.next = list.next;
				list.next = curr;
			}
			return curr;
		}
	};
	/** @type {import('./list.d.ts').listGet} */
	var listGet = function(objects, key) {
		if (!objects) return;
		var node = listGetNode(objects, key);
		return node && node.value;
	};
	/** @type {import('./list.d.ts').listSet} */
	var listSet = function(objects, key, value) {
		var node = listGetNode(objects, key);
		if (node) node.value = value;
		else objects.next = {
			key,
			next: objects.next,
			value
		};
	};
	/** @type {import('./list.d.ts').listHas} */
	var listHas = function(objects, key) {
		if (!objects) return false;
		return !!listGetNode(objects, key);
	};
	/** @type {import('./list.d.ts').listDelete} */
	var listDelete = function(objects, key) {
		if (objects) return listGetNode(objects, key, true);
	};
	/** @type {import('.')} */
	module.exports = function getSideChannelList() {
		/** @typedef {ReturnType<typeof getSideChannelList>} Channel */
		/** @typedef {Parameters<Channel['get']>[0]} K */
		/** @typedef {Parameters<Channel['set']>[1]} V */
		/** @type {import('./list.d.ts').RootNode<V, K> | undefined} */ var $o;
		/** @type {Channel} */
		var channel = {
			assert: function(key) {
				if (!channel.has(key)) throw new $TypeError("Side channel does not contain " + inspect(key));
			},
			"delete": function(key) {
				var deletedNode = listDelete($o, key);
				if (deletedNode && $o && !$o.next) $o = void 0;
				return !!deletedNode;
			},
			get: function(key) {
				return listGet($o, key);
			},
			has: function(key) {
				return listHas($o, key);
			},
			set: function(key, value) {
				if (!$o) $o = { next: void 0 };
				listSet($o, key, value);
			}
		};
		return channel;
	};
}));
//#endregion
//#region node_modules/call-bound/index.js
var require_call_bound = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var GetIntrinsic = require_get_intrinsic();
	var callBindBasic = require_call_bind_apply_helpers();
	/** @type {(thisArg: string, searchString: string, position?: number) => number} */
	var $indexOf = callBindBasic([GetIntrinsic("%String.prototype.indexOf%")]);
	/** @type {import('.')} */
	module.exports = function callBoundIntrinsic(name, allowMissing) {
		var intrinsic = GetIntrinsic(name, !!allowMissing);
		if (typeof intrinsic === "function" && $indexOf(name, ".prototype.") > -1) return callBindBasic([intrinsic]);
		return intrinsic;
	};
}));
//#endregion
//#region node_modules/side-channel-map/index.js
var require_side_channel_map = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var GetIntrinsic = require_get_intrinsic();
	var callBound = require_call_bound();
	var inspect = require_object_inspect();
	var $TypeError = require_type();
	var $Map = GetIntrinsic("%Map%", true);
	/** @type {<K, V>(thisArg: Map<K, V>, key: K) => V} */
	var $mapGet = callBound("Map.prototype.get", true);
	/** @type {<K, V>(thisArg: Map<K, V>, key: K, value: V) => void} */
	var $mapSet = callBound("Map.prototype.set", true);
	/** @type {<K, V>(thisArg: Map<K, V>, key: K) => boolean} */
	var $mapHas = callBound("Map.prototype.has", true);
	/** @type {<K, V>(thisArg: Map<K, V>, key: K) => boolean} */
	var $mapDelete = callBound("Map.prototype.delete", true);
	/** @type {<K, V>(thisArg: Map<K, V>) => number} */
	var $mapSize = callBound("Map.prototype.size", true);
	/** @type {import('.')} */
	module.exports = !!$Map && function getSideChannelMap() {
		/** @typedef {ReturnType<typeof getSideChannelMap>} Channel */
		/** @typedef {Parameters<Channel['get']>[0]} K */
		/** @typedef {Parameters<Channel['set']>[1]} V */
		/** @type {Map<K, V> | undefined} */ var $m;
		/** @type {Channel} */
		var channel = {
			assert: function(key) {
				if (!channel.has(key)) throw new $TypeError("Side channel does not contain " + inspect(key));
			},
			"delete": function(key) {
				if ($m) {
					var result = $mapDelete($m, key);
					if ($mapSize($m) === 0) $m = void 0;
					return result;
				}
				return false;
			},
			get: function(key) {
				if ($m) return $mapGet($m, key);
			},
			has: function(key) {
				if ($m) return $mapHas($m, key);
				return false;
			},
			set: function(key, value) {
				if (!$m) $m = new $Map();
				$mapSet($m, key, value);
			}
		};
		return channel;
	};
}));
//#endregion
//#region node_modules/side-channel-weakmap/index.js
var require_side_channel_weakmap = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var GetIntrinsic = require_get_intrinsic();
	var callBound = require_call_bound();
	var inspect = require_object_inspect();
	var getSideChannelMap = require_side_channel_map();
	var $TypeError = require_type();
	var $WeakMap = GetIntrinsic("%WeakMap%", true);
	/** @type {<K extends object, V>(thisArg: WeakMap<K, V>, key: K) => V} */
	var $weakMapGet = callBound("WeakMap.prototype.get", true);
	/** @type {<K extends object, V>(thisArg: WeakMap<K, V>, key: K, value: V) => void} */
	var $weakMapSet = callBound("WeakMap.prototype.set", true);
	/** @type {<K extends object, V>(thisArg: WeakMap<K, V>, key: K) => boolean} */
	var $weakMapHas = callBound("WeakMap.prototype.has", true);
	/** @type {<K extends object, V>(thisArg: WeakMap<K, V>, key: K) => boolean} */
	var $weakMapDelete = callBound("WeakMap.prototype.delete", true);
	/** @type {import('.')} */
	module.exports = $WeakMap ? function getSideChannelWeakMap() {
		/** @typedef {ReturnType<typeof getSideChannelWeakMap>} Channel */
		/** @typedef {Parameters<Channel['get']>[0]} K */
		/** @typedef {Parameters<Channel['set']>[1]} V */
		/** @type {WeakMap<K & object, V> | undefined} */ var $wm;
		/** @type {Channel | undefined} */ var $m;
		/** @type {Channel} */
		var channel = {
			assert: function(key) {
				if (!channel.has(key)) throw new $TypeError("Side channel does not contain " + inspect(key));
			},
			"delete": function(key) {
				if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
					if ($wm) return $weakMapDelete($wm, key);
				} else if (getSideChannelMap) {
					if ($m) return $m["delete"](key);
				}
				return false;
			},
			get: function(key) {
				if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
					if ($wm) return $weakMapGet($wm, key);
				}
				return $m && $m.get(key);
			},
			has: function(key) {
				if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
					if ($wm) return $weakMapHas($wm, key);
				}
				return !!$m && $m.has(key);
			},
			set: function(key, value) {
				if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
					if (!$wm) $wm = new $WeakMap();
					$weakMapSet($wm, key, value);
				} else if (getSideChannelMap) {
					if (!$m) $m = getSideChannelMap();
					/** @type {NonNullable<typeof $m>} */ $m.set(key, value);
				}
			}
		};
		return channel;
	} : getSideChannelMap;
}));
//#endregion
//#region node_modules/side-channel/index.js
var require_side_channel = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var $TypeError = require_type();
	var inspect = require_object_inspect();
	var getSideChannelList = require_side_channel_list();
	var getSideChannelMap = require_side_channel_map();
	var makeChannel = require_side_channel_weakmap() || getSideChannelMap || getSideChannelList;
	/** @type {import('.')} */
	module.exports = function getSideChannel() {
		/** @typedef {ReturnType<typeof getSideChannel>} Channel */
		/** @type {Channel | undefined} */ var $channelData;
		/** @type {Channel} */
		var channel = {
			assert: function(key) {
				if (!channel.has(key)) throw new $TypeError("Side channel does not contain " + inspect(key));
			},
			"delete": function(key) {
				return !!$channelData && $channelData["delete"](key);
			},
			get: function(key) {
				return $channelData && $channelData.get(key);
			},
			has: function(key) {
				return !!$channelData && $channelData.has(key);
			},
			set: function(key, value) {
				if (!$channelData) $channelData = makeChannel();
				$channelData.set(key, value);
			}
		};
		return channel;
	};
}));
//#endregion
//#region node_modules/qs/lib/formats.js
var require_formats = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var replace = String.prototype.replace;
	var percentTwenties = /%20/g;
	var Format = {
		RFC1738: "RFC1738",
		RFC3986: "RFC3986"
	};
	module.exports = {
		"default": Format.RFC3986,
		formatters: {
			RFC1738: function(value) {
				return replace.call(value, percentTwenties, "+");
			},
			RFC3986: function(value) {
				return String(value);
			}
		},
		RFC1738: Format.RFC1738,
		RFC3986: Format.RFC3986
	};
}));
//#endregion
//#region node_modules/qs/lib/utils.js
var require_utils$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var formats = require_formats();
	var getSideChannel = require_side_channel();
	var has = Object.prototype.hasOwnProperty;
	var isArray = Array.isArray;
	var overflowChannel = getSideChannel();
	var markOverflow = function markOverflow(obj, maxIndex) {
		overflowChannel.set(obj, maxIndex);
		return obj;
	};
	var isOverflow = function isOverflow(obj) {
		return overflowChannel.has(obj);
	};
	var getMaxIndex = function getMaxIndex(obj) {
		return overflowChannel.get(obj);
	};
	var setMaxIndex = function setMaxIndex(obj, maxIndex) {
		overflowChannel.set(obj, maxIndex);
	};
	var hexTable = function() {
		var array = [];
		for (var i = 0; i < 256; ++i) array[array.length] = "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase();
		return array;
	}();
	var compactQueue = function compactQueue(queue) {
		while (queue.length > 1) {
			var item = queue.pop();
			var obj = item.obj[item.prop];
			if (isArray(obj)) {
				var compacted = [];
				for (var j = 0; j < obj.length; ++j) if (typeof obj[j] !== "undefined") compacted[compacted.length] = obj[j];
				item.obj[item.prop] = compacted;
			}
		}
	};
	var arrayToObject = function arrayToObject(source, options) {
		var obj = options && options.plainObjects ? { __proto__: null } : {};
		for (var i = 0; i < source.length; ++i) if (typeof source[i] !== "undefined") obj[i] = source[i];
		return obj;
	};
	var merge = function merge(target, source, options) {
		if (!source) return target;
		if (typeof source !== "object" && typeof source !== "function") {
			if (isArray(target)) {
				var nextIndex = target.length;
				if (options && typeof options.arrayLimit === "number" && nextIndex > options.arrayLimit) return markOverflow(arrayToObject(target.concat(source), options), nextIndex);
				target[nextIndex] = source;
			} else if (target && typeof target === "object") {
				if (isOverflow(target)) {
					var newIndex = getMaxIndex(target) + 1;
					target[newIndex] = source;
					setMaxIndex(target, newIndex);
				} else if (options && (options.plainObjects || options.allowPrototypes) || !has.call(Object.prototype, source)) target[source] = true;
			} else return [target, source];
			return target;
		}
		if (!target || typeof target !== "object") {
			if (isOverflow(source)) {
				var sourceKeys = Object.keys(source);
				var result = options && options.plainObjects ? {
					__proto__: null,
					0: target
				} : { 0: target };
				for (var m = 0; m < sourceKeys.length; m++) {
					var oldKey = parseInt(sourceKeys[m], 10);
					result[oldKey + 1] = source[sourceKeys[m]];
				}
				return markOverflow(result, getMaxIndex(source) + 1);
			}
			var combined = [target].concat(source);
			if (options && typeof options.arrayLimit === "number" && combined.length > options.arrayLimit) return markOverflow(arrayToObject(combined, options), combined.length - 1);
			return combined;
		}
		var mergeTarget = target;
		if (isArray(target) && !isArray(source)) mergeTarget = arrayToObject(target, options);
		if (isArray(target) && isArray(source)) {
			source.forEach(function(item, i) {
				if (has.call(target, i)) {
					var targetItem = target[i];
					if (targetItem && typeof targetItem === "object" && item && typeof item === "object") target[i] = merge(targetItem, item, options);
					else target[target.length] = item;
				} else target[i] = item;
			});
			return target;
		}
		return Object.keys(source).reduce(function(acc, key) {
			var value = source[key];
			if (has.call(acc, key)) acc[key] = merge(acc[key], value, options);
			else acc[key] = value;
			if (isOverflow(source) && !isOverflow(acc)) markOverflow(acc, getMaxIndex(source));
			if (isOverflow(acc)) {
				var keyNum = parseInt(key, 10);
				if (String(keyNum) === key && keyNum >= 0 && keyNum > getMaxIndex(acc)) setMaxIndex(acc, keyNum);
			}
			return acc;
		}, mergeTarget);
	};
	var assign = function assignSingleSource(target, source) {
		return Object.keys(source).reduce(function(acc, key) {
			acc[key] = source[key];
			return acc;
		}, target);
	};
	var decode = function(str, defaultDecoder, charset) {
		var strWithoutPlus = str.replace(/\+/g, " ");
		if (charset === "iso-8859-1") return strWithoutPlus.replace(/%[0-9a-f]{2}/gi, unescape);
		try {
			return decodeURIComponent(strWithoutPlus);
		} catch (e) {
			return strWithoutPlus;
		}
	};
	var limit = 1024;
	module.exports = {
		arrayToObject,
		assign,
		combine: function combine(a, b, arrayLimit, plainObjects) {
			if (isOverflow(a)) {
				var newIndex = getMaxIndex(a) + 1;
				a[newIndex] = b;
				setMaxIndex(a, newIndex);
				return a;
			}
			var result = [].concat(a, b);
			if (result.length > arrayLimit) return markOverflow(arrayToObject(result, { plainObjects }), result.length - 1);
			return result;
		},
		compact: function compact(value) {
			var queue = [{
				obj: { o: value },
				prop: "o"
			}];
			var refs = [];
			for (var i = 0; i < queue.length; ++i) {
				var item = queue[i];
				var obj = item.obj[item.prop];
				var keys = Object.keys(obj);
				for (var j = 0; j < keys.length; ++j) {
					var key = keys[j];
					var val = obj[key];
					if (typeof val === "object" && val !== null && refs.indexOf(val) === -1) {
						queue[queue.length] = {
							obj,
							prop: key
						};
						refs[refs.length] = val;
					}
				}
			}
			compactQueue(queue);
			return value;
		},
		decode,
		encode: function encode(str, defaultEncoder, charset, kind, format) {
			if (str.length === 0) return str;
			var string = str;
			if (typeof str === "symbol") string = Symbol.prototype.toString.call(str);
			else if (typeof str !== "string") string = String(str);
			if (charset === "iso-8859-1") return escape(string).replace(/%u[0-9a-f]{4}/gi, function($0) {
				return "%26%23" + parseInt($0.slice(2), 16) + "%3B";
			});
			var out = "";
			for (var j = 0; j < string.length; j += limit) {
				var segment = string.length >= limit ? string.slice(j, j + limit) : string;
				var arr = [];
				for (var i = 0; i < segment.length; ++i) {
					var c = segment.charCodeAt(i);
					if (c === 45 || c === 46 || c === 95 || c === 126 || c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || format === formats.RFC1738 && (c === 40 || c === 41)) {
						arr[arr.length] = segment.charAt(i);
						continue;
					}
					if (c < 128) {
						arr[arr.length] = hexTable[c];
						continue;
					}
					if (c < 2048) {
						arr[arr.length] = hexTable[192 | c >> 6] + hexTable[128 | c & 63];
						continue;
					}
					if (c < 55296 || c >= 57344) {
						arr[arr.length] = hexTable[224 | c >> 12] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
						continue;
					}
					i += 1;
					c = 65536 + ((c & 1023) << 10 | segment.charCodeAt(i) & 1023);
					arr[arr.length] = hexTable[240 | c >> 18] + hexTable[128 | c >> 12 & 63] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
				}
				out += arr.join("");
			}
			return out;
		},
		isBuffer: function isBuffer(obj) {
			if (!obj || typeof obj !== "object") return false;
			return !!(obj.constructor && obj.constructor.isBuffer && obj.constructor.isBuffer(obj));
		},
		isOverflow,
		isRegExp: function isRegExp(obj) {
			return Object.prototype.toString.call(obj) === "[object RegExp]";
		},
		markOverflow,
		maybeMap: function maybeMap(val, fn) {
			if (isArray(val)) {
				var mapped = [];
				for (var i = 0; i < val.length; i += 1) mapped[mapped.length] = fn(val[i]);
				return mapped;
			}
			return fn(val);
		},
		merge
	};
}));
//#endregion
//#region node_modules/qs/lib/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var getSideChannel = require_side_channel();
	var utils = require_utils$1();
	var formats = require_formats();
	var has = Object.prototype.hasOwnProperty;
	var arrayPrefixGenerators = {
		brackets: function brackets(prefix) {
			return prefix + "[]";
		},
		comma: "comma",
		indices: function indices(prefix, key) {
			return prefix + "[" + key + "]";
		},
		repeat: function repeat(prefix) {
			return prefix;
		}
	};
	var isArray = Array.isArray;
	var push = Array.prototype.push;
	var pushToArray = function(arr, valueOrArray) {
		push.apply(arr, isArray(valueOrArray) ? valueOrArray : [valueOrArray]);
	};
	var toISO = Date.prototype.toISOString;
	var defaultFormat = formats["default"];
	var defaults = {
		addQueryPrefix: false,
		allowDots: false,
		allowEmptyArrays: false,
		arrayFormat: "indices",
		charset: "utf-8",
		charsetSentinel: false,
		commaRoundTrip: false,
		delimiter: "&",
		encode: true,
		encodeDotInKeys: false,
		encoder: utils.encode,
		encodeValuesOnly: false,
		filter: void 0,
		format: defaultFormat,
		formatter: formats.formatters[defaultFormat],
		indices: false,
		serializeDate: function serializeDate(date) {
			return toISO.call(date);
		},
		skipNulls: false,
		strictNullHandling: false
	};
	var isNonNullishPrimitive = function isNonNullishPrimitive(v) {
		return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "symbol" || typeof v === "bigint";
	};
	var sentinel = {};
	var stringify = function stringify(object, prefix, generateArrayPrefix, commaRoundTrip, allowEmptyArrays, strictNullHandling, skipNulls, encodeDotInKeys, encoder, filter, sort, allowDots, serializeDate, format, formatter, encodeValuesOnly, charset, sideChannel) {
		var obj = object;
		var tmpSc = sideChannel;
		var step = 0;
		var findFlag = false;
		while ((tmpSc = tmpSc.get(sentinel)) !== void 0 && !findFlag) {
			var pos = tmpSc.get(object);
			step += 1;
			if (typeof pos !== "undefined") if (pos === step) throw new RangeError("Cyclic object value");
			else findFlag = true;
			if (typeof tmpSc.get(sentinel) === "undefined") step = 0;
		}
		if (typeof filter === "function") obj = filter(prefix, obj);
		else if (obj instanceof Date) obj = serializeDate(obj);
		else if (generateArrayPrefix === "comma" && isArray(obj)) obj = utils.maybeMap(obj, function(value) {
			if (value instanceof Date) return serializeDate(value);
			return value;
		});
		if (obj === null) {
			if (strictNullHandling) return encoder && !encodeValuesOnly ? encoder(prefix, defaults.encoder, charset, "key", format) : prefix;
			obj = "";
		}
		if (isNonNullishPrimitive(obj) || utils.isBuffer(obj)) {
			if (encoder) return [formatter(encodeValuesOnly ? prefix : encoder(prefix, defaults.encoder, charset, "key", format)) + "=" + formatter(encoder(obj, defaults.encoder, charset, "value", format))];
			return [formatter(prefix) + "=" + formatter(String(obj))];
		}
		var values = [];
		if (typeof obj === "undefined") return values;
		var objKeys;
		if (generateArrayPrefix === "comma" && isArray(obj)) {
			if (encodeValuesOnly && encoder) obj = utils.maybeMap(obj, encoder);
			objKeys = [{ value: obj.length > 0 ? obj.join(",") || null : void 0 }];
		} else if (isArray(filter)) objKeys = filter;
		else {
			var keys = Object.keys(obj);
			objKeys = sort ? keys.sort(sort) : keys;
		}
		var encodedPrefix = encodeDotInKeys ? String(prefix).replace(/\./g, "%2E") : String(prefix);
		var adjustedPrefix = commaRoundTrip && isArray(obj) && obj.length === 1 ? encodedPrefix + "[]" : encodedPrefix;
		if (allowEmptyArrays && isArray(obj) && obj.length === 0) return adjustedPrefix + "[]";
		for (var j = 0; j < objKeys.length; ++j) {
			var key = objKeys[j];
			var value = typeof key === "object" && key && typeof key.value !== "undefined" ? key.value : obj[key];
			if (skipNulls && value === null) continue;
			var encodedKey = allowDots && encodeDotInKeys ? String(key).replace(/\./g, "%2E") : String(key);
			var keyPrefix = isArray(obj) ? typeof generateArrayPrefix === "function" ? generateArrayPrefix(adjustedPrefix, encodedKey) : adjustedPrefix : adjustedPrefix + (allowDots ? "." + encodedKey : "[" + encodedKey + "]");
			sideChannel.set(object, step);
			var valueSideChannel = getSideChannel();
			valueSideChannel.set(sentinel, sideChannel);
			pushToArray(values, stringify(value, keyPrefix, generateArrayPrefix, commaRoundTrip, allowEmptyArrays, strictNullHandling, skipNulls, encodeDotInKeys, generateArrayPrefix === "comma" && encodeValuesOnly && isArray(obj) ? null : encoder, filter, sort, allowDots, serializeDate, format, formatter, encodeValuesOnly, charset, valueSideChannel));
		}
		return values;
	};
	var normalizeStringifyOptions = function normalizeStringifyOptions(opts) {
		if (!opts) return defaults;
		if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
		if (typeof opts.encodeDotInKeys !== "undefined" && typeof opts.encodeDotInKeys !== "boolean") throw new TypeError("`encodeDotInKeys` option can only be `true` or `false`, when provided");
		if (opts.encoder !== null && typeof opts.encoder !== "undefined" && typeof opts.encoder !== "function") throw new TypeError("Encoder has to be a function.");
		var charset = opts.charset || defaults.charset;
		if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
		var format = formats["default"];
		if (typeof opts.format !== "undefined") {
			if (!has.call(formats.formatters, opts.format)) throw new TypeError("Unknown format option provided.");
			format = opts.format;
		}
		var formatter = formats.formatters[format];
		var filter = defaults.filter;
		if (typeof opts.filter === "function" || isArray(opts.filter)) filter = opts.filter;
		var arrayFormat;
		if (opts.arrayFormat in arrayPrefixGenerators) arrayFormat = opts.arrayFormat;
		else if ("indices" in opts) arrayFormat = opts.indices ? "indices" : "repeat";
		else arrayFormat = defaults.arrayFormat;
		if ("commaRoundTrip" in opts && typeof opts.commaRoundTrip !== "boolean") throw new TypeError("`commaRoundTrip` must be a boolean, or absent");
		var allowDots = typeof opts.allowDots === "undefined" ? opts.encodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;
		return {
			addQueryPrefix: typeof opts.addQueryPrefix === "boolean" ? opts.addQueryPrefix : defaults.addQueryPrefix,
			allowDots,
			allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
			arrayFormat,
			charset,
			charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
			commaRoundTrip: !!opts.commaRoundTrip,
			delimiter: typeof opts.delimiter === "undefined" ? defaults.delimiter : opts.delimiter,
			encode: typeof opts.encode === "boolean" ? opts.encode : defaults.encode,
			encodeDotInKeys: typeof opts.encodeDotInKeys === "boolean" ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
			encoder: typeof opts.encoder === "function" ? opts.encoder : defaults.encoder,
			encodeValuesOnly: typeof opts.encodeValuesOnly === "boolean" ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
			filter,
			format,
			formatter,
			serializeDate: typeof opts.serializeDate === "function" ? opts.serializeDate : defaults.serializeDate,
			skipNulls: typeof opts.skipNulls === "boolean" ? opts.skipNulls : defaults.skipNulls,
			sort: typeof opts.sort === "function" ? opts.sort : null,
			strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling
		};
	};
	module.exports = function(object, opts) {
		var obj = object;
		var options = normalizeStringifyOptions(opts);
		var objKeys;
		var filter;
		if (typeof options.filter === "function") {
			filter = options.filter;
			obj = filter("", obj);
		} else if (isArray(options.filter)) {
			filter = options.filter;
			objKeys = filter;
		}
		var keys = [];
		if (typeof obj !== "object" || obj === null) return "";
		var generateArrayPrefix = arrayPrefixGenerators[options.arrayFormat];
		var commaRoundTrip = generateArrayPrefix === "comma" && options.commaRoundTrip;
		if (!objKeys) objKeys = Object.keys(obj);
		if (options.sort) objKeys.sort(options.sort);
		var sideChannel = getSideChannel();
		for (var i = 0; i < objKeys.length; ++i) {
			var key = objKeys[i];
			var value = obj[key];
			if (options.skipNulls && value === null) continue;
			pushToArray(keys, stringify(value, key, generateArrayPrefix, commaRoundTrip, options.allowEmptyArrays, options.strictNullHandling, options.skipNulls, options.encodeDotInKeys, options.encode ? options.encoder : null, options.filter, options.sort, options.allowDots, options.serializeDate, options.format, options.formatter, options.encodeValuesOnly, options.charset, sideChannel));
		}
		var joined = keys.join(options.delimiter);
		var prefix = options.addQueryPrefix === true ? "?" : "";
		if (options.charsetSentinel) if (options.charset === "iso-8859-1") prefix += "utf8=%26%2310003%3B&";
		else prefix += "utf8=%E2%9C%93&";
		return joined.length > 0 ? prefix + joined : "";
	};
}));
//#endregion
//#region node_modules/qs/lib/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var utils = require_utils$1();
	var has = Object.prototype.hasOwnProperty;
	var isArray = Array.isArray;
	var defaults = {
		allowDots: false,
		allowEmptyArrays: false,
		allowPrototypes: false,
		allowSparse: false,
		arrayLimit: 20,
		charset: "utf-8",
		charsetSentinel: false,
		comma: false,
		decodeDotInKeys: false,
		decoder: utils.decode,
		delimiter: "&",
		depth: 5,
		duplicates: "combine",
		ignoreQueryPrefix: false,
		interpretNumericEntities: false,
		parameterLimit: 1e3,
		parseArrays: true,
		plainObjects: false,
		strictDepth: false,
		strictNullHandling: false,
		throwOnLimitExceeded: false
	};
	var interpretNumericEntities = function(str) {
		return str.replace(/&#(\d+);/g, function($0, numberStr) {
			return String.fromCharCode(parseInt(numberStr, 10));
		});
	};
	var parseArrayValue = function(val, options, currentArrayLength) {
		if (val && typeof val === "string" && options.comma && val.indexOf(",") > -1) return val.split(",");
		if (options.throwOnLimitExceeded && currentArrayLength >= options.arrayLimit) throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
		return val;
	};
	var isoSentinel = "utf8=%26%2310003%3B";
	var charsetSentinel = "utf8=%E2%9C%93";
	var parseValues = function parseQueryStringValues(str, options) {
		var obj = { __proto__: null };
		var cleanStr = options.ignoreQueryPrefix ? str.replace(/^\?/, "") : str;
		cleanStr = cleanStr.replace(/%5B/gi, "[").replace(/%5D/gi, "]");
		var limit = options.parameterLimit === Infinity ? void 0 : options.parameterLimit;
		var parts = cleanStr.split(options.delimiter, options.throwOnLimitExceeded ? limit + 1 : limit);
		if (options.throwOnLimitExceeded && parts.length > limit) throw new RangeError("Parameter limit exceeded. Only " + limit + " parameter" + (limit === 1 ? "" : "s") + " allowed.");
		var skipIndex = -1;
		var i;
		var charset = options.charset;
		if (options.charsetSentinel) {
			for (i = 0; i < parts.length; ++i) if (parts[i].indexOf("utf8=") === 0) {
				if (parts[i] === charsetSentinel) charset = "utf-8";
				else if (parts[i] === isoSentinel) charset = "iso-8859-1";
				skipIndex = i;
				i = parts.length;
			}
		}
		for (i = 0; i < parts.length; ++i) {
			if (i === skipIndex) continue;
			var part = parts[i];
			var bracketEqualsPos = part.indexOf("]=");
			var pos = bracketEqualsPos === -1 ? part.indexOf("=") : bracketEqualsPos + 1;
			var key;
			var val;
			if (pos === -1) {
				key = options.decoder(part, defaults.decoder, charset, "key");
				val = options.strictNullHandling ? null : "";
			} else {
				key = options.decoder(part.slice(0, pos), defaults.decoder, charset, "key");
				if (key !== null) val = utils.maybeMap(parseArrayValue(part.slice(pos + 1), options, isArray(obj[key]) ? obj[key].length : 0), function(encodedVal) {
					return options.decoder(encodedVal, defaults.decoder, charset, "value");
				});
			}
			if (val && options.interpretNumericEntities && charset === "iso-8859-1") val = interpretNumericEntities(String(val));
			if (part.indexOf("[]=") > -1) val = isArray(val) ? [val] : val;
			if (options.comma && isArray(val) && val.length > options.arrayLimit) {
				if (options.throwOnLimitExceeded) throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
				val = utils.combine([], val, options.arrayLimit, options.plainObjects);
			}
			if (key !== null) {
				var existing = has.call(obj, key);
				if (existing && options.duplicates === "combine") obj[key] = utils.combine(obj[key], val, options.arrayLimit, options.plainObjects);
				else if (!existing || options.duplicates === "last") obj[key] = val;
			}
		}
		return obj;
	};
	var parseObject = function(chain, val, options, valuesParsed) {
		var currentArrayLength = 0;
		if (chain.length > 0 && chain[chain.length - 1] === "[]") {
			var parentKey = chain.slice(0, -1).join("");
			currentArrayLength = Array.isArray(val) && val[parentKey] ? val[parentKey].length : 0;
		}
		var leaf = valuesParsed ? val : parseArrayValue(val, options, currentArrayLength);
		for (var i = chain.length - 1; i >= 0; --i) {
			var obj;
			var root = chain[i];
			if (root === "[]" && options.parseArrays) if (utils.isOverflow(leaf)) obj = leaf;
			else obj = options.allowEmptyArrays && (leaf === "" || options.strictNullHandling && leaf === null) ? [] : utils.combine([], leaf, options.arrayLimit, options.plainObjects);
			else {
				obj = options.plainObjects ? { __proto__: null } : {};
				var cleanRoot = root.charAt(0) === "[" && root.charAt(root.length - 1) === "]" ? root.slice(1, -1) : root;
				var decodedRoot = options.decodeDotInKeys ? cleanRoot.replace(/%2E/g, ".") : cleanRoot;
				var index = parseInt(decodedRoot, 10);
				var isValidArrayIndex = !isNaN(index) && root !== decodedRoot && String(index) === decodedRoot && index >= 0 && options.parseArrays;
				if (!options.parseArrays && decodedRoot === "") obj = { 0: leaf };
				else if (isValidArrayIndex && index < options.arrayLimit) {
					obj = [];
					obj[index] = leaf;
				} else if (isValidArrayIndex && options.throwOnLimitExceeded) throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
				else if (isValidArrayIndex) {
					obj[index] = leaf;
					utils.markOverflow(obj, index);
				} else if (decodedRoot !== "__proto__") obj[decodedRoot] = leaf;
			}
			leaf = obj;
		}
		return leaf;
	};
	var splitKeyIntoSegments = function splitKeyIntoSegments(givenKey, options) {
		var key = options.allowDots ? givenKey.replace(/\.([^.[]+)/g, "[$1]") : givenKey;
		if (options.depth <= 0) {
			if (!options.plainObjects && has.call(Object.prototype, key)) {
				if (!options.allowPrototypes) return;
			}
			return [key];
		}
		var brackets = /(\[[^[\]]*])/;
		var child = /(\[[^[\]]*])/g;
		var segment = brackets.exec(key);
		var parent = segment ? key.slice(0, segment.index) : key;
		var keys = [];
		if (parent) {
			if (!options.plainObjects && has.call(Object.prototype, parent)) {
				if (!options.allowPrototypes) return;
			}
			keys[keys.length] = parent;
		}
		var i = 0;
		while ((segment = child.exec(key)) !== null && i < options.depth) {
			i += 1;
			var segmentContent = segment[1].slice(1, -1);
			if (!options.plainObjects && has.call(Object.prototype, segmentContent)) {
				if (!options.allowPrototypes) return;
			}
			keys[keys.length] = segment[1];
		}
		if (segment) {
			if (options.strictDepth === true) throw new RangeError("Input depth exceeded depth option of " + options.depth + " and strictDepth is true");
			keys[keys.length] = "[" + key.slice(segment.index) + "]";
		}
		return keys;
	};
	var parseKeys = function parseQueryStringKeys(givenKey, val, options, valuesParsed) {
		if (!givenKey) return;
		var keys = splitKeyIntoSegments(givenKey, options);
		if (!keys) return;
		return parseObject(keys, val, options, valuesParsed);
	};
	var normalizeParseOptions = function normalizeParseOptions(opts) {
		if (!opts) return defaults;
		if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
		if (typeof opts.decodeDotInKeys !== "undefined" && typeof opts.decodeDotInKeys !== "boolean") throw new TypeError("`decodeDotInKeys` option can only be `true` or `false`, when provided");
		if (opts.decoder !== null && typeof opts.decoder !== "undefined" && typeof opts.decoder !== "function") throw new TypeError("Decoder has to be a function.");
		if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
		if (typeof opts.throwOnLimitExceeded !== "undefined" && typeof opts.throwOnLimitExceeded !== "boolean") throw new TypeError("`throwOnLimitExceeded` option must be a boolean");
		var charset = typeof opts.charset === "undefined" ? defaults.charset : opts.charset;
		var duplicates = typeof opts.duplicates === "undefined" ? defaults.duplicates : opts.duplicates;
		if (duplicates !== "combine" && duplicates !== "first" && duplicates !== "last") throw new TypeError("The duplicates option must be either combine, first, or last");
		return {
			allowDots: typeof opts.allowDots === "undefined" ? opts.decodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots,
			allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
			allowPrototypes: typeof opts.allowPrototypes === "boolean" ? opts.allowPrototypes : defaults.allowPrototypes,
			allowSparse: typeof opts.allowSparse === "boolean" ? opts.allowSparse : defaults.allowSparse,
			arrayLimit: typeof opts.arrayLimit === "number" ? opts.arrayLimit : defaults.arrayLimit,
			charset,
			charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
			comma: typeof opts.comma === "boolean" ? opts.comma : defaults.comma,
			decodeDotInKeys: typeof opts.decodeDotInKeys === "boolean" ? opts.decodeDotInKeys : defaults.decodeDotInKeys,
			decoder: typeof opts.decoder === "function" ? opts.decoder : defaults.decoder,
			delimiter: typeof opts.delimiter === "string" || utils.isRegExp(opts.delimiter) ? opts.delimiter : defaults.delimiter,
			depth: typeof opts.depth === "number" || opts.depth === false ? +opts.depth : defaults.depth,
			duplicates,
			ignoreQueryPrefix: opts.ignoreQueryPrefix === true,
			interpretNumericEntities: typeof opts.interpretNumericEntities === "boolean" ? opts.interpretNumericEntities : defaults.interpretNumericEntities,
			parameterLimit: typeof opts.parameterLimit === "number" ? opts.parameterLimit : defaults.parameterLimit,
			parseArrays: opts.parseArrays !== false,
			plainObjects: typeof opts.plainObjects === "boolean" ? opts.plainObjects : defaults.plainObjects,
			strictDepth: typeof opts.strictDepth === "boolean" ? !!opts.strictDepth : defaults.strictDepth,
			strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling,
			throwOnLimitExceeded: typeof opts.throwOnLimitExceeded === "boolean" ? opts.throwOnLimitExceeded : false
		};
	};
	module.exports = function(str, opts) {
		var options = normalizeParseOptions(opts);
		if (str === "" || str === null || typeof str === "undefined") return options.plainObjects ? { __proto__: null } : {};
		var tempObj = typeof str === "string" ? parseValues(str, options) : str;
		var obj = options.plainObjects ? { __proto__: null } : {};
		var keys = Object.keys(tempObj);
		for (var i = 0; i < keys.length; ++i) {
			var key = keys[i];
			var newObj = parseKeys(key, tempObj[key], options, typeof str === "string");
			obj = utils.merge(obj, newObj, options);
		}
		if (options.allowSparse === true) return obj;
		return utils.compact(obj);
	};
}));
//#endregion
//#region node_modules/qs/lib/index.js
var require_lib = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var stringify = require_stringify();
	var parse = require_parse();
	module.exports = {
		formats: require_formats(),
		parse,
		stringify
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/bot/sign-in.js
var require_sign_in$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	const BOT_SIGNIN_ENDPOINTS = {
		URL: "api/botsignin/GetSignInUrl",
		RESOURCE: "api/botsignin/GetSignInResource"
	};
	var BotSignInClient = class {
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async getUrl(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${BOT_SIGNIN_ENDPOINTS.URL}?${q}`)).data;
		}
		async getResource(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${BOT_SIGNIN_ENDPOINTS.RESOURCE}?${q}`)).data;
		}
	};
	exports.BOT_SIGNIN_ENDPOINTS = BOT_SIGNIN_ENDPOINTS;
	exports.BotSignInClient = BotSignInClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/bot/index.js
var require_bot = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var signIn = require_sign_in$3();
	var BotClient = class {
		signIn;
		get http() {
			return this._http;
		}
		set http(v) {
			this.signIn.http = v;
			this._http = v;
		}
		_http;
		_clientSettings;
		constructor(options, clientSettings) {
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._clientSettings = apiClientSettings.mergeApiClientSettings(clientSettings);
			this.signIn = new signIn.BotSignInClient(this.http, this._clientSettings);
		}
	};
	exports.BotClient = BotClient;
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-post-resource.js
var require_token_post_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-request.js
var require_token_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-response.js
var require_token_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-status.js
var require_token_status = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/index.js
var require_token$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tokenPostResource = require_token_post_resource();
	var tokenRequest = require_token_request();
	var tokenResponse = require_token_response();
	var tokenStatus = require_token_status();
	Object.keys(tokenPostResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenPostResource[k];
			}
		});
	});
	Object.keys(tokenRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenRequest[k];
			}
		});
	});
	Object.keys(tokenResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenResponse[k];
			}
		});
	});
	Object.keys(tokenStatus).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenStatus[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-invoke-request.js
var require_token_exchange_invoke_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-invoke-response.js
var require_token_exchange_invoke_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-request.js
var require_token_exchange_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-resource.js
var require_token_exchange_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-state.js
var require_token_exchange_state = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/index.js
var require_token_exchange$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tokenExchangeInvokeRequest = require_token_exchange_invoke_request();
	var tokenExchangeInvokeResponse = require_token_exchange_invoke_response();
	var tokenExchangeRequest = require_token_exchange_request();
	var tokenExchangeResource = require_token_exchange_resource();
	var tokenExchangeState = require_token_exchange_state();
	Object.keys(tokenExchangeInvokeRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeInvokeRequest[k];
			}
		});
	});
	Object.keys(tokenExchangeInvokeResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeInvokeResponse[k];
			}
		});
	});
	Object.keys(tokenExchangeRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeRequest[k];
			}
		});
	});
	Object.keys(tokenExchangeResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeResource[k];
			}
		});
	});
	Object.keys(tokenExchangeState).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeState[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-card.js
var require_sign_in_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-url-response.js
var require_sign_in_url_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-state-verify-query.js
var require_sign_in_state_verify_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-exchange-token.js
var require_sign_in_exchange_token = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-failure.js
var require_sign_in_failure = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/index.js
var require_sign_in$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var signInCard = require_sign_in_card();
	var signInUrlResponse = require_sign_in_url_response();
	var signInStateVerifyQuery = require_sign_in_state_verify_query();
	var signInExchangeToken = require_sign_in_exchange_token();
	var signInFailure = require_sign_in_failure();
	Object.keys(signInCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInCard[k];
			}
		});
	});
	Object.keys(signInUrlResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInUrlResponse[k];
			}
		});
	});
	Object.keys(signInStateVerifyQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInStateVerifyQuery[k];
			}
		});
	});
	Object.keys(signInExchangeToken).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInExchangeToken[k];
			}
		});
	});
	Object.keys(signInFailure).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInFailure[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/oauth/oauth-card.js
var require_oauth_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/oauth/index.js
var require_oauth = /* @__PURE__ */ __commonJSMin(((exports) => {
	var oauthCard = require_oauth_card();
	Object.keys(oauthCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return oauthCard[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/role.js
var require_role = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/account.js
var require_account = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveAadObjectId(data) {
		return {
			...data,
			aadObjectId: data.aadObjectId ?? data.objectId
		};
	}
	exports.resolveAadObjectId = resolveAadObjectId;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/client-info-entity.js
var require_client_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/mention-entity.js
var require_mention_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/message-entity.js
var require_message_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/ai-message-entity.js
var require_ai_message_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/stream-info-entity.js
var require_stream_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/citation-entity.js
var require_citation_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/sensitive-usage-entity.js
var require_sensitive_usage_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/product-info-entity.js
var require_product_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/quoted-reply-entity.js
var require_quoted_reply_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/targeted-message-info-entity.js
var require_targeted_message_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/index.js
var require_entity = /* @__PURE__ */ __commonJSMin(((exports) => {
	var clientInfoEntity = require_client_info_entity();
	var mentionEntity = require_mention_entity();
	var messageEntity = require_message_entity();
	var aiMessageEntity = require_ai_message_entity();
	var streamInfoEntity = require_stream_info_entity();
	var citationEntity = require_citation_entity();
	var sensitiveUsageEntity = require_sensitive_usage_entity();
	var productInfoEntity = require_product_info_entity();
	var quotedReplyEntity = require_quoted_reply_entity();
	var targetedMessageInfoEntity = require_targeted_message_info_entity();
	Object.keys(clientInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return clientInfoEntity[k];
			}
		});
	});
	Object.keys(mentionEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mentionEntity[k];
			}
		});
	});
	Object.keys(messageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageEntity[k];
			}
		});
	});
	Object.keys(aiMessageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return aiMessageEntity[k];
			}
		});
	});
	Object.keys(streamInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return streamInfoEntity[k];
			}
		});
	});
	Object.keys(citationEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return citationEntity[k];
			}
		});
	});
	Object.keys(sensitiveUsageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return sensitiveUsageEntity[k];
			}
		});
	});
	Object.keys(productInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return productInfoEntity[k];
			}
		});
	});
	Object.keys(quotedReplyEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return quotedReplyEntity[k];
			}
		});
	});
	Object.keys(targetedMessageInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return targetedMessageInfoEntity[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/input-hint.js
var require_input_hint = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/text-format.js
var require_text_format = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/attachment.js
var require_attachment$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/card-attachment.js
var require_card_attachment = /* @__PURE__ */ __commonJSMin(((exports) => {
	function cardAttachment(type, content) {
		return {
			contentType: `application/vnd.microsoft.card.${type}`,
			content
		};
	}
	exports.cardAttachment = cardAttachment;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/attachment-layout.js
var require_attachment_layout = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/index.js
var require_attachment = /* @__PURE__ */ __commonJSMin(((exports) => {
	var attachment = require_attachment$1();
	var cardAttachment = require_card_attachment();
	var attachmentLayout = require_attachment_layout();
	Object.keys(attachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachment[k];
			}
		});
	});
	Object.keys(cardAttachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardAttachment[k];
			}
		});
	});
	Object.keys(attachmentLayout).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachmentLayout[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/suggested-actions.js
var require_suggested_actions = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/importance.js
var require_importance = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/delivery-mode.js
var require_delivery_mode = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/error.js
var require_error = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation.js
var require_conversation$3 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation-reference.js
var require_conversation_reference = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation-resource.js
var require_conversation_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/paged-members-result.js
var require_paged_members_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/index.js
var require_conversation$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var conversation = require_conversation$3();
	var conversationReference = require_conversation_reference();
	var conversationResource = require_conversation_resource();
	var pagedMembersResult = require_paged_members_result();
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(conversationReference).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationReference[k];
			}
		});
	});
	Object.keys(conversationResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationResource[k];
			}
		});
	});
	Object.keys(pagedMembersResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return pagedMembersResult[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/resource.js
var require_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/cache-info.js
var require_cache_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/config-auth.js
var require_config_auth = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/config-response.js
var require_config_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/index.js
var require_config$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var configAuth = require_config_auth();
	var configResponse = require_config_response();
	Object.keys(configAuth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configAuth[k];
			}
		});
	});
	Object.keys(configResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configResponse[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-card-response.js
var require_task_module_card_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-continue-response.js
var require_task_module_continue_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-message-response.js
var require_task_module_message_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-response.js
var require_task_module_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-task-info.js
var require_task_module_task_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-request.js
var require_task_module_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/index.js
var require_task_module = /* @__PURE__ */ __commonJSMin(((exports) => {
	var taskModuleCardResponse = require_task_module_card_response();
	var taskModuleContinueResponse = require_task_module_continue_response();
	var taskModuleMessageResponse = require_task_module_message_response();
	var taskModuleResponse = require_task_module_response();
	var taskModuleTaskInfo = require_task_module_task_info();
	var taskModuleRequest = require_task_module_request();
	Object.keys(taskModuleCardResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleCardResponse[k];
			}
		});
	});
	Object.keys(taskModuleContinueResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleContinueResponse[k];
			}
		});
	});
	Object.keys(taskModuleMessageResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleMessageResponse[k];
			}
		});
	});
	Object.keys(taskModuleResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleResponse[k];
			}
		});
	});
	Object.keys(taskModuleTaskInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleTaskInfo[k];
			}
		});
	});
	Object.keys(taskModuleRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleRequest[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-consent-card.js
var require_file_consent_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-info-card.js
var require_file_info_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-upload-info.js
var require_file_upload_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/index.js
var require_file = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fileConsentCard = require_file_consent_card();
	var fileInfoCard = require_file_info_card();
	var fileUploadInfo = require_file_upload_info();
	Object.keys(fileConsentCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileConsentCard[k];
			}
		});
	});
	Object.keys(fileInfoCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileInfoCard[k];
			}
		});
	});
	Object.keys(fileUploadInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileUploadInfo[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/action.js
var require_action$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/o365/o365-connector-card-action-query.js
var require_o365_connector_card_action_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/o365/index.js
var require_o365 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var o365ConnectorCardActionQuery = require_o365_connector_card_action_query();
	Object.keys(o365ConnectorCardActionQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return o365ConnectorCardActionQuery[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/app-based-link-query.js
var require_app_based_link_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-attachment.js
var require_messaging_extension_attachment = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-response.js
var require_messaging_extension_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-result.js
var require_messaging_extension_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-suggested-action.js
var require_messaging_extension_suggested_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-parameter.js
var require_messaging_extension_parameter = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-query.js
var require_messaging_extension_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-action.js
var require_messaging_extension_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-action-response.js
var require_messaging_extension_action_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-attachment-layout.js
var require_messaging_extension_attachment_layout = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/index.js
var require_messaging_extension = /* @__PURE__ */ __commonJSMin(((exports) => {
	var messagingExtensionAttachment = require_messaging_extension_attachment();
	var messagingExtensionResponse = require_messaging_extension_response();
	var messagingExtensionResult = require_messaging_extension_result();
	var messagingExtensionSuggestedAction = require_messaging_extension_suggested_action();
	var messagingExtensionParameter = require_messaging_extension_parameter();
	var messagingExtensionQuery = require_messaging_extension_query();
	var messagingExtensionAction = require_messaging_extension_action();
	var messagingExtensionActionResponse = require_messaging_extension_action_response();
	var messagingExtensionAttachmentLayout = require_messaging_extension_attachment_layout();
	Object.keys(messagingExtensionAttachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAttachment[k];
			}
		});
	});
	Object.keys(messagingExtensionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionResponse[k];
			}
		});
	});
	Object.keys(messagingExtensionResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionResult[k];
			}
		});
	});
	Object.keys(messagingExtensionSuggestedAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionSuggestedAction[k];
			}
		});
	});
	Object.keys(messagingExtensionParameter).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionParameter[k];
			}
		});
	});
	Object.keys(messagingExtensionQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionQuery[k];
			}
		});
	});
	Object.keys(messagingExtensionAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAction[k];
			}
		});
	});
	Object.keys(messagingExtensionActionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionActionResponse[k];
			}
		});
	});
	Object.keys(messagingExtensionAttachmentLayout).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAttachmentLayout[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message.js
var require_message$4 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-app.js
var require_message_app = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-body.js
var require_message_body = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-conversation.js
var require_message_conversation = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-from.js
var require_message_from = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-mention.js
var require_message_mention = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-reaction.js
var require_message_reaction$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-user.js
var require_message_user = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/index.js
var require_message$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var message = require_message$4();
	var messageApp = require_message_app();
	var messageBody = require_message_body();
	var messageConversation = require_message_conversation();
	var messageFrom = require_message_from();
	var messageMention = require_message_mention();
	var messageReaction = require_message_reaction$1();
	var messageUser = require_message_user();
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(messageApp).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageApp[k];
			}
		});
	});
	Object.keys(messageBody).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageBody[k];
			}
		});
	});
	Object.keys(messageConversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageConversation[k];
			}
		});
	});
	Object.keys(messageFrom).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageFrom[k];
			}
		});
	});
	Object.keys(messageMention).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageMention[k];
			}
		});
	});
	Object.keys(messageReaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageReaction[k];
			}
		});
	});
	Object.keys(messageUser).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageUser[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-entity-context.js
var require_tab_entity_context = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-context.js
var require_tab_context = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-request.js
var require_tab_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-response.js
var require_tab_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-response-card.js
var require_tab_response_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-submit.js
var require_tab_submit$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-suggested-actions.js
var require_tab_suggested_actions = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/index.js
var require_tab$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tabEntityContext = require_tab_entity_context();
	var tabContext = require_tab_context();
	var tabRequest = require_tab_request();
	var tabResponse = require_tab_response();
	var tabResponseCard = require_tab_response_card();
	var tabSubmit = require_tab_submit$1();
	var tabSuggestedActions = require_tab_suggested_actions();
	Object.keys(tabEntityContext).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabEntityContext[k];
			}
		});
	});
	Object.keys(tabContext).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabContext[k];
			}
		});
	});
	Object.keys(tabRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabRequest[k];
			}
		});
	});
	Object.keys(tabResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabResponse[k];
			}
		});
	});
	Object.keys(tabResponseCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabResponseCard[k];
			}
		});
	});
	Object.keys(tabSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSubmit[k];
			}
		});
	});
	Object.keys(tabSuggestedActions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSuggestedActions[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/animation-card.js
var require_animation_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/audio-card.js
var require_audio_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/basic-card.js
var require_basic_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/card-image.js
var require_card_image = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/hero-card.js
var require_hero_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/media-card.js
var require_media_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/media-url.js
var require_media_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/thumbnail-card.js
var require_thumbnail_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/thumbnail-url.js
var require_thumbnail_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/video-card.js
var require_video_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/card-action.js
var require_card_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/index.js
var require_card = /* @__PURE__ */ __commonJSMin(((exports) => {
	var animationCard = require_animation_card();
	var audioCard = require_audio_card();
	var basicCard = require_basic_card();
	var cardImage = require_card_image();
	var heroCard = require_hero_card();
	var mediaCard = require_media_card();
	var mediaUrl = require_media_url();
	var thumbnailCard = require_thumbnail_card();
	var thumbnailUrl = require_thumbnail_url();
	var videoCard = require_video_card();
	var cardAction = require_card_action();
	Object.keys(animationCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return animationCard[k];
			}
		});
	});
	Object.keys(audioCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return audioCard[k];
			}
		});
	});
	Object.keys(basicCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return basicCard[k];
			}
		});
	});
	Object.keys(cardImage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardImage[k];
			}
		});
	});
	Object.keys(heroCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return heroCard[k];
			}
		});
	});
	Object.keys(mediaCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mediaCard[k];
			}
		});
	});
	Object.keys(mediaUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mediaUrl[k];
			}
		});
	});
	Object.keys(thumbnailCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return thumbnailCard[k];
			}
		});
	});
	Object.keys(thumbnailUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return thumbnailUrl[k];
			}
		});
	});
	Object.keys(videoCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return videoCard[k];
			}
		});
	});
	Object.keys(cardAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/invoke-response.js
var require_invoke_response = /* @__PURE__ */ __commonJSMin(((exports) => {
	function isInvokeResponse(value) {
		return typeof value === "object" && "status" in value && typeof value.status === "number";
	}
	exports.isInvokeResponse = isInvokeResponse;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-source-types.js
var require_membership_source_types = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-source.js
var require_membership_source = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-types.js
var require_membership_types = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-authentication.js
var require_adaptive_card_authentication = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-invoke-action.js
var require_adaptive_card_invoke_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-invoke-value.js
var require_adaptive_card_invoke_value = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-action-response.js
var require_adaptive_card_action_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/index.js
var require_adaptive_card$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var adaptiveCardAuthentication = require_adaptive_card_authentication();
	var adaptiveCardInvokeAction = require_adaptive_card_invoke_action();
	var adaptiveCardInvokeValue = require_adaptive_card_invoke_value();
	var adaptiveCardActionResponse = require_adaptive_card_action_response();
	Object.keys(adaptiveCardAuthentication).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardAuthentication[k];
			}
		});
	});
	Object.keys(adaptiveCardInvokeAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardInvokeAction[k];
			}
		});
	});
	Object.keys(adaptiveCardInvokeValue).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardInvokeValue[k];
			}
		});
	});
	Object.keys(adaptiveCardActionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardActionResponse[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/channel-info.js
var require_channel_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/notification-info.js
var require_notification_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/on-behalf-of.js
var require_on_behalf_of = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/settings.js
var require_settings = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/team-info.js
var require_team_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/tenant-info.js
var require_tenant_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/feedback-loop.js
var require_feedback_loop = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/index.js
var require_channel_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var channelInfo = require_channel_info();
	var notificationInfo = require_notification_info();
	var onBehalfOf = require_on_behalf_of();
	var settings = require_settings();
	var teamInfo = require_team_info();
	var tenantInfo = require_tenant_info();
	var feedbackLoop = require_feedback_loop();
	Object.keys(channelInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelInfo[k];
			}
		});
	});
	Object.keys(notificationInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return notificationInfo[k];
			}
		});
	});
	Object.keys(onBehalfOf).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return onBehalfOf[k];
			}
		});
	});
	Object.keys(settings).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return settings[k];
			}
		});
	});
	Object.keys(teamInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return teamInfo[k];
			}
		});
	});
	Object.keys(tenantInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tenantInfo[k];
			}
		});
	});
	Object.keys(feedbackLoop).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return feedbackLoop[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/team-details.js
var require_team_details = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting.js
var require_meeting$2 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-info.js
var require_meeting_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-details.js
var require_meeting_details = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-notification.js
var require_meeting_notification = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-participant.js
var require_meeting_participant = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/index.js
var require_meeting$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var meeting = require_meeting$2();
	var meetingInfo = require_meeting_info();
	var meetingDetails = require_meeting_details();
	var meetingNotification = require_meeting_notification();
	var meetingParticipant = require_meeting_participant();
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(meetingInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingInfo[k];
			}
		});
	});
	Object.keys(meetingDetails).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingDetails[k];
			}
		});
	});
	Object.keys(meetingNotification).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingNotification[k];
			}
		});
	});
	Object.keys(meetingParticipant).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipant[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-id.js
var require_channel_id = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/activity-like.js
var require_activity_like = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/index.js
var require_models = /* @__PURE__ */ __commonJSMin(((exports) => {
	var token = require_token$2();
	var tokenExchange = require_token_exchange$1();
	var signIn = require_sign_in$2();
	var oauth = require_oauth();
	var role = require_role();
	var account = require_account();
	var entity = require_entity();
	var inputHint = require_input_hint();
	var textFormat = require_text_format();
	var attachment = require_attachment();
	var suggestedActions = require_suggested_actions();
	var importance = require_importance();
	var deliveryMode = require_delivery_mode();
	var error = require_error();
	var conversation = require_conversation$2();
	var resource = require_resource();
	var cacheInfo = require_cache_info();
	var config = require_config$1();
	var taskModule = require_task_module();
	var file = require_file();
	var action = require_action$1();
	var o365 = require_o365();
	var appBasedLinkQuery = require_app_based_link_query();
	var messagingExtension = require_messaging_extension();
	var message = require_message$3();
	var tab = require_tab$1();
	var card = require_card();
	var invokeResponse = require_invoke_response();
	var membershipSourceTypes = require_membership_source_types();
	var membershipSource = require_membership_source();
	var membershipTypes = require_membership_types();
	var adaptiveCard = require_adaptive_card$1();
	var channelData = require_channel_data();
	var teamDetails = require_team_details();
	var meeting = require_meeting$1();
	var channelId = require_channel_id();
	var activityLike = require_activity_like();
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
	Object.keys(tokenExchange).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchange[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(oauth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return oauth[k];
			}
		});
	});
	Object.keys(role).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return role[k];
			}
		});
	});
	Object.keys(account).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return account[k];
			}
		});
	});
	Object.keys(entity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return entity[k];
			}
		});
	});
	Object.keys(inputHint).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return inputHint[k];
			}
		});
	});
	Object.keys(textFormat).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return textFormat[k];
			}
		});
	});
	Object.keys(attachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachment[k];
			}
		});
	});
	Object.keys(suggestedActions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return suggestedActions[k];
			}
		});
	});
	Object.keys(importance).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return importance[k];
			}
		});
	});
	Object.keys(deliveryMode).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return deliveryMode[k];
			}
		});
	});
	Object.keys(error).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return error[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(resource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return resource[k];
			}
		});
	});
	Object.keys(cacheInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cacheInfo[k];
			}
		});
	});
	Object.keys(config).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return config[k];
			}
		});
	});
	Object.keys(taskModule).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModule[k];
			}
		});
	});
	Object.keys(file).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return file[k];
			}
		});
	});
	Object.keys(action).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return action[k];
			}
		});
	});
	Object.keys(o365).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return o365[k];
			}
		});
	});
	Object.keys(appBasedLinkQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return appBasedLinkQuery[k];
			}
		});
	});
	Object.keys(messagingExtension).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtension[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(tab).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tab[k];
			}
		});
	});
	Object.keys(card).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return card[k];
			}
		});
	});
	Object.keys(invokeResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invokeResponse[k];
			}
		});
	});
	Object.keys(membershipSourceTypes).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipSourceTypes[k];
			}
		});
	});
	Object.keys(membershipSource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipSource[k];
			}
		});
	});
	Object.keys(membershipTypes).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipTypes[k];
			}
		});
	});
	Object.keys(adaptiveCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCard[k];
			}
		});
	});
	Object.keys(channelData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelData[k];
			}
		});
	});
	Object.keys(teamDetails).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return teamDetails[k];
			}
		});
	});
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(channelId).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelId[k];
			}
		});
	});
	Object.keys(activityLike).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activityLike[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/activity.js
var require_activity$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var models = require_models();
	var apiClientSettings = require_api_client_settings();
	var ConversationActivityClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async create(conversationId, params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities`, params)).data;
		}
		async update(conversationId, id, params) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`, params)).data;
		}
		async reply(conversationId, id, params) {
			params.replyToId = id;
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`, params)).data;
		}
		async delete(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`)).data;
		}
		async getMembers(conversationId, id) {
			return ((await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}/members`)).data ?? []).map(models.resolveAadObjectId);
		}
		async createTargeted(conversationId, params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities?isTargetedActivity=true`, params)).data;
		}
		async updateTargeted(conversationId, id, params) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}?isTargetedActivity=true`, params)).data;
		}
		async deleteTargeted(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}?isTargetedActivity=true`)).data;
		}
	};
	exports.ConversationActivityClient = ConversationActivityClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/member.js
var require_member = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var models = require_models();
	var apiClientSettings = require_api_client_settings();
	var ConversationMemberClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async get(conversationId) {
			return (await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/members`)).data.map(models.resolveAadObjectId);
		}
		async getById(conversationId, id) {
			const res = await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/members/${id}`);
			return models.resolveAadObjectId(res.data);
		}
		/**
		* Get paged members in a conversation.
		* @param conversationId - The ID of the conversation.
		* @param pageSize - Optional maximum number of members per page (min 50, default 200, max 500).
		* @param continuationToken - Optional token from a previous call to fetch the next page.
		* @returns PagedMembersResult containing members and an optional continuation token.
		*/
		async getPaged(conversationId, pageSize, continuationToken) {
			const params = {};
			if (pageSize !== void 0) params["pageSize"] = pageSize;
			if (continuationToken !== void 0) params["continuationToken"] = continuationToken;
			const res = await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/pagedMembers`, { params });
			return {
				...res.data,
				members: res.data.members.map(models.resolveAadObjectId)
			};
		}
		/**
		* @deprecated This will be removed by end of summer 2026.
		*/
		async delete(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/members/${id}`)).data;
		}
	};
	exports.ConversationMemberClient = ConversationMemberClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/index.js
var require_conversation$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var activity = require_activity$1();
	var member = require_member();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	var ConversationClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_activities;
		_members;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
			this._activities = new activity.ConversationActivityClient(serviceUrl, this.http, this._apiClientSettings);
			this._members = new member.ConversationMemberClient(serviceUrl, this.http, this._apiClientSettings);
		}
		activities(conversationId) {
			return {
				create: (params) => this._activities.create(conversationId, params),
				update: (id, params) => this._activities.update(conversationId, id, params),
				reply: (id, params) => this._activities.reply(conversationId, id, params),
				delete: (id) => this._activities.delete(conversationId, id),
				members: (activityId) => this._activities.getMembers(conversationId, activityId),
				createTargeted: (params) => this._activities.createTargeted(conversationId, params),
				updateTargeted: (id, params) => this._activities.updateTargeted(conversationId, id, params),
				deleteTargeted: (id) => this._activities.deleteTargeted(conversationId, id)
			};
		}
		members(conversationId) {
			return {
				get: () => this._members.get(conversationId),
				getById: (id) => this._members.getById(conversationId, id),
				getPaged: (pageSize, continuationToken) => this._members.getPaged(conversationId, pageSize, continuationToken),
				/**
				* @deprecated This will be removed by end of summer 2026.
				*/
				delete: (id) => this._members.delete(conversationId, id)
			};
		}
		/**
		* @deprecated This will be removed by end of summer 2026.
		*/
		async get(params) {
			const q = qs__default.default.stringify(params, { addQueryPrefix: true });
			return (await this.http.get(`${this.serviceUrl}/v3/conversations${q}`)).data;
		}
		async create(params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations`, params)).data;
		}
	};
	exports.ConversationClient = ConversationClient;
	Object.keys(activity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activity[k];
			}
		});
	});
	Object.keys(member).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return member[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/meeting.js
var require_meeting = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var MeetingClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		/**
		* Retrieves meeting information including details, organizer, and conversation.
		* @param id - The meeting ID.
		*/
		async getById(id) {
			return (await this.http.get(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(id)}`)).data;
		}
		/**
		* Retrieves information about a specific participant in a meeting.
		* @param meetingId - The meeting ID.
		* @param id - The user AAD object ID
		* @param tenantId - The tenant ID of the meeting and user.
		* @returns {MeetingParticipant} The meeting participant information.
		*/
		async getParticipant(meetingId, id, tenantId) {
			return (await this.http.get(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`)).data;
		}
		/**
		* Send a targeted in-meeting notification to specific participants.
		*
		* Returns `undefined` on full success (HTTP 202). Returns a `MeetingNotificationResponse`
		* with per-recipient failure info on partial success (HTTP 207).
		*
		* Requires the RSC permission `OnlineMeetingNotification.Send.Chat` and the ECS flag
		* enabled for the tenant/bot.
		*
		* @param meetingId - The BASE64-encoded meeting ID.
		* @param params - The notification parameters including recipients and surfaces.
		*/
		async sendNotification(meetingId, params) {
			const body = {
				type: params.type ?? "targetedMeetingNotification",
				value: params.value
			};
			return (await this.http.post(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(meetingId)}/notification`, body)).data || void 0;
		}
	};
	exports.MeetingClient = MeetingClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/reaction/reaction.js
var require_reaction$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var ReactionClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		/**
		* Add a reaction to a message.
		*/
		async add(conversationId, activityId, reactionType) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`)).data;
		}
		/**
		* Delete a reaction from a message.
		*/
		async delete(conversationId, activityId, reactionType) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`)).data;
		}
	};
	exports.ReactionClient = ReactionClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/reaction/index.js
var require_reaction = /* @__PURE__ */ __commonJSMin(((exports) => {
	var reaction = require_reaction$1();
	Object.keys(reaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return reaction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/team.js
var require_team = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var TeamClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async getById(id) {
			return (await this.http.get(`${this.serviceUrl}/v3/teams/${id}`)).data;
		}
		async getConversations(id) {
			return (await this.http.get(`${this.serviceUrl}/v3/teams/${id}/conversations`)).data.conversations;
		}
	};
	exports.TeamClient = TeamClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/user/token.js
var require_token$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	const USER_TOKEN_ENDPOINTS = {
		GET_TOKEN: "api/usertoken/GetToken",
		GET_AAD_TOKENS: "api/usertoken/GetAadTokens",
		GET_STATUS: "api/usertoken/GetTokenStatus",
		SIGN_OUT: "api/usertoken/SignOut",
		EXCHANGE: "api/usertoken/exchange"
	};
	var UserTokenClient = class {
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async get(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_TOKEN}?${q}`)).data;
		}
		async getAad(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.post(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_AAD_TOKENS}?${q}`, params)).data;
		}
		async getStatus(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_STATUS}?${q}`)).data;
		}
		async signOut(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.delete(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.SIGN_OUT}?${q}`, { data: params })).data;
		}
		async exchange(params) {
			const q = qs__default.default.stringify({
				userId: params.userId,
				connectionName: params.connectionName,
				channelId: params.channelId
			});
			return (await this.http.post(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.EXCHANGE}?${q}`, params.exchangeRequest)).data;
		}
	};
	exports.USER_TOKEN_ENDPOINTS = USER_TOKEN_ENDPOINTS;
	exports.UserTokenClient = UserTokenClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/user/index.js
var require_user = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var token = require_token$1();
	var UserClient = class {
		token;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
			this.token = new token.UserTokenClient(this.http, this._apiClientSettings);
		}
	};
	exports.UserClient = UserClient;
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/index.js
var require_clients = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$2();
	var apiClientSettings = require_api_client_settings();
	var bot = require_bot();
	var conversation = require_conversation$1();
	var meeting = require_meeting();
	var reaction = require_reaction();
	var team = require_team();
	var user = require_user();
	var Client = class {
		serviceUrl;
		bots;
		users;
		conversations;
		teams;
		meetings;
		reactions;
		get http() {
			return this._http;
		}
		set http(v) {
			this.bots.http = v;
			this.conversations.http = v;
			this.users.http = v;
			this.teams.http = v;
			this.meetings.http = v;
			this.reactions.http = v;
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1, cloud) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new teams_common.Client();
			else if ("request" in options) this._http = options;
			else this._http = new teams_common.Client({
				...options,
				headers: {
					...options?.headers,
					"Content-Type": "application/json"
				}
			});
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1, cloud);
			this.bots = new bot.BotClient(this.http, this._apiClientSettings);
			this.users = new user.UserClient(this.http, this._apiClientSettings);
			this.conversations = new conversation.ConversationClient(serviceUrl, this.http, this._apiClientSettings);
			this.teams = new team.TeamClient(serviceUrl, this.http, this._apiClientSettings);
			this.meetings = new meeting.MeetingClient(serviceUrl, this.http, this._apiClientSettings);
			this.reactions = new reaction.ReactionClient(serviceUrl, this.http, this._apiClientSettings);
		}
	};
	exports.Client = Client;
	Object.keys(apiClientSettings).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return apiClientSettings[k];
			}
		});
	});
	Object.keys(bot).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return bot[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(reaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return reaction[k];
			}
		});
	});
	Object.keys(team).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return team[k];
			}
		});
	});
	Object.keys(user).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return user[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/activity.js
var require_activity = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.Activity = class Activity {
		/**
		* Contains the type of the activity.
		*/
		type;
		/**
		* Contains an ID that uniquely identifies the activity on the channel.
		*/
		id;
		/**
		* Contains the URL that specifies the channel's service endpoint. Set by the channel.
		*/
		serviceUrl;
		/**
		* Contains the date and time that the message was sent, in UTC, expressed in ISO-8601 format.
		*/
		timestamp;
		/**
		* A locale name for the contents of the text field.
		* The locale name is a combination of an ISO 639 two- or three-letter culture code associated
		* with a language
		* and an ISO 3166 two-letter subculture code associated with a country or region.
		* The locale name can also correspond to a valid BCP-47 language tag.
		*/
		locale;
		/**
		* Contains the local date and time of the message, expressed in ISO-8601 format.
		*
		* For example, 2016-09-23T13:07:49.4714686-07:00.
		*/
		localTimestamp;
		/**
		* Contains an ID that uniquely identifies the channel. Set by the channel.
		*/
		channelId;
		/**
		* Identifies the sender of the message.
		*/
		from;
		/**
		* Identifies the conversation to which the activity belongs.
		*/
		conversation;
		/**
		* A reference to another conversation or activity.
		* @deprecated This will be removed by end of summer 2026.
		*/
		relatesTo;
		/**
		* Identifies the recipient of the message.
		*/
		recipient;
		/**
		* Contains the ID of the message to which this message is a reply.
		*/
		replyToId;
		/**
		* Represents the entities that were mentioned in the message.
		*/
		entities;
		/**
		* Contains channel-specific content.
		*/
		channelData;
		/**
		* Information about the tenant in which the message was sent.
		*/
		get tenant() {
			return this.channelData?.tenant;
		}
		/**
		* Information about the channel in which the message was sent.
		*/
		get channel() {
			return this.channelData?.channel;
		}
		/**
		* Information about the team in which the message was sent.
		*/
		get team() {
			return this.channelData?.team;
		}
		/**
		* Information about the tenant in which the message was sent.
		*/
		get meeting() {
			return this.channelData?.meeting;
		}
		/**
		* Notification settings for the message.
		*/
		get notification() {
			return this.channelData?.notification;
		}
		constructor(value) {
			Object.assign(this, {
				channelId: "msteams",
				...value
			});
		}
		static from(activity) {
			return new Activity(activity);
		}
		toInterface() {
			return Object.assign({}, this);
		}
		clone(options = {}) {
			return new Activity({
				...this.toInterface(),
				...options
			});
		}
		withId(value) {
			this.id = value;
			return this;
		}
		withReplyToId(value) {
			this.replyToId = value;
			return this;
		}
		withChannelId(value) {
			this.channelId = value;
			return this;
		}
		withFrom(value) {
			this.from = value;
			return this;
		}
		withConversation(value) {
			this.conversation = value;
			return this;
		}
		/**
		* @deprecated This will be removed by end of summer 2026.
		*/
		withRelatesTo(value) {
			this.relatesTo = value;
			return this;
		}
		/**
		* Set the recipient of this activity, optionally marking it as a targeted message.
		* Targeted messages are ephemeral to the specified recipient in a shared conversation.
		* @param value - The recipient account
		* @param isTargeted - If true, marks this as a targeted message visible only to the recipient (default: false)
		* @returns this instance for chaining
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsTargeted
		*/
		withRecipient(value, isTargeted = false) {
			this.recipient = {
				...value,
				isTargeted: isTargeted ? true : void 0
			};
			return this;
		}
		withServiceUrl(value) {
			this.serviceUrl = value;
			return this;
		}
		withTimestamp(value) {
			this.timestamp = value;
			return this;
		}
		withLocale(value) {
			this.locale = value;
			return this;
		}
		withLocalTimestamp(value) {
			this.localTimestamp = value;
			return this;
		}
		withChannelData(value) {
			const merged = {
				...this.channelData,
				...value
			};
			if (merged.feedbackLoop !== void 0) merged.feedbackLoopEnabled = void 0;
			else if (merged.feedbackLoopEnabled === true) {
				merged.feedbackLoop = { type: "default" };
				merged.feedbackLoopEnabled = void 0;
			}
			this.channelData = merged;
			return this;
		}
		/**
		* Add an entity.
		*/
		addEntity(value) {
			if (!this.entities) this.entities = [];
			this.entities.push(value);
			return this;
		}
		/**
		* Add multiple entities
		*/
		addEntities(...value) {
			if (!this.entities) this.entities = [];
			this.entities.push(...value);
			return this;
		}
		/**
		* Add the `Generated By AI` label.
		*/
		addAiGenerated() {
			const messageEntity = this.ensureSingleRootLevelMessageEntity();
			if (messageEntity.additionalType?.includes("AIGeneratedContent")) return this;
			if (!messageEntity.additionalType) messageEntity.additionalType = [];
			messageEntity.additionalType.push("AIGeneratedContent");
			return this;
		}
		/**
		* Enable message feedback.
		* @param mode - `'default'` shows Teams' built-in thumbs up/down UI.
		*               `'custom'` triggers a `message/fetchTask` invoke so the bot can return its own task module dialog.
		*/
		addFeedback(mode = "default") {
			if (!this.channelData) this.channelData = {};
			this.channelData.feedbackLoop = { type: mode };
			this.channelData.feedbackLoopEnabled = void 0;
			return this;
		}
		/**
		* Add citations
		*/
		addCitation(position, appearance) {
			const messageEntity = this.ensureSingleRootLevelMessageEntity();
			if (!messageEntity.citation) messageEntity.citation = [];
			messageEntity.citation.push({
				"@type": "Claim",
				position,
				appearance: {
					"@type": "DigitalDocument",
					abstract: appearance.abstract,
					name: appearance.name,
					encodingFormat: "application/vnd.microsoft.card.adaptive",
					image: appearance.icon ? {
						"@type": "ImageObject",
						name: appearance.icon
					} : void 0,
					keywords: appearance.keywords,
					text: appearance.text,
					url: appearance.url,
					usageInfo: appearance.usageInfo
				}
			});
			return this;
		}
		/**
		* Add a targeted message info entity for prompt preview.
		* Skips if already present. In reactive flows, `ctx.send()` and `ctx.reply()`
		* populate this automatically — use this helper for proactive or deferred sends.
		* An invalid or expired messageId causes APX to silently drop the preview
		* while still delivering the message.
		*
		* @param messageId the message ID of the targeted message (from the incoming activity's `id`)
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsTargeted
		*/
		addTargetedMessageInfo(messageId) {
			if (this.entities) this.entities = this.entities.filter((e) => e.type !== "quotedReply");
			if (this.type === "message") {
				const msg = this;
				if (msg.text) msg.text = msg.text.replace(`<quoted messageId="${messageId}"/>`, "").trim();
			}
			if (this.entities?.some((e) => e.type === "targetedMessageInfo")) return this;
			return this.addEntity({
				type: "targetedMessageInfo",
				messageId
			});
		}
		/**
		* is this a streaming activity
		*/
		isStreaming() {
			return this.entities?.some((e) => e.type === "streaminfo") || false;
		}
		/**
		* Get or create the base message entity.
		* There should only be one root level message entity.
		*/
		ensureSingleRootLevelMessageEntity() {
			let mesageEntity = this.entities?.find((e) => e.type === "https://schema.org/Message" && e["@type"] === "Message");
			if (!mesageEntity) {
				mesageEntity = {
					type: "https://schema.org/Message",
					"@type": "Message",
					"@context": "https://schema.org",
					"@id": ""
				};
				this.addEntity(mesageEntity);
			}
			return mesageEntity;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-delete.js
var require_message_delete = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageDeleteActivity = class MessageDeleteActivity extends activity.Activity {
		constructor(value = {}) {
			super({
				...value,
				type: "messageDelete",
				channelData: {
					...value.channelData,
					eventType: "softDeleteMessage"
				}
			});
			Object.assign(this, {
				...value,
				channelData: {
					...value.channelData,
					eventType: "softDeleteMessage"
				}
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageDeleteActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageDeleteActivity({
				...this.toInterface(),
				...options
			});
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/strip-mentions-text.js
var require_strip_mentions_text = /* @__PURE__ */ __commonJSMin(((exports) => {
	function stripMentionsText(activity, { accountId, tagOnly } = {}) {
		if (!activity.text) return;
		let text = activity.text;
		for (const mention of activity.entities?.filter((e) => e.type === "mention") || []) {
			if (accountId && mention.mentioned.id !== accountId) continue;
			if (mention.text) {
				const textWithoutTags = mention.text.replace("<at>", "").replace("</at>", "");
				text = text.replace(mention.text, !tagOnly ? "" : textWithoutTags);
			} else text = text.replace(`<at>${mention.mentioned.name}</at>`, !tagOnly ? "" : mention.mentioned.name);
		}
		return text.trim();
	}
	exports.stripMentionsText = stripMentionsText;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/core.js
var require_core = /* @__PURE__ */ __commonJSMin(((exports) => {
	function isAdaptiveCard(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "AdaptiveCard";
	}
	var AdaptiveCard = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **AdaptiveCard**.
		*/
		type = "AdaptiveCard";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* A URL to the Adaptive Card schema the card is authored against.
		*/
		$schema;
		/**
		* The Adaptive Card schema version the card is authored against.
		*/
		version = "1.5";
		/**
		* The text that should be displayed if the client is not able to render the card.
		*/
		fallbackText;
		/**
		* The text that should be spoken for the entire card.
		*/
		speak;
		/**
		* Defines how the card can be refreshed by making a request to the target Bot.
		*/
		refresh;
		/**
		* Defines authentication information to enable on-behalf-of single-sign-on or just-in-time OAuth. This information is used in conjunction with the refresh property and Action.Execute in general.
		*/
		authentication;
		/**
		* Teams-specific metadata associated with the card.
		*/
		msteams;
		/**
		* Metadata associated with the card.
		*/
		metadata;
		/**
		* Resources card elements can reference.
		*/
		resources;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The body of the card, comprised of a list of elements displayed according to the layouts property. If the layouts property is not specified, a Layout.Stack is used.
		*/
		body;
		/**
		* The card level actions, which always appear at the bottom of the card.
		*/
		actions;
		constructor(...body) {
			this.body = body;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		with$schema($schema) {
			this.$schema = $schema;
			return this;
		}
		withVersion(version) {
			this.version = version;
			return this;
		}
		withFallbackText(fallbackText) {
			this.fallbackText = fallbackText;
			return this;
		}
		withSpeak(speak) {
			this.speak = speak;
			return this;
		}
		withRefresh(refresh) {
			this.refresh = refresh;
			return this;
		}
		withAuthentication(authentication) {
			this.authentication = authentication;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withMetadata(metadata) {
			this.metadata = metadata;
			return this;
		}
		withResources(resources) {
			this.resources = resources;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withBody(...body) {
			this.body = body;
			return this;
		}
		withActions(...actions) {
			this.actions = actions;
			return this;
		}
	};
	var HostCapabilities = class HostCapabilities {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HostCapabilities(options);
		}
	};
	function isExecuteAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Execute";
	}
	var ExecuteAction = class ExecuteAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Execute**.
		*/
		type = "Action.Execute";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The data to send to the Bot when the action is executed. When expressed as an object, `data` is sent back to the Bot when the action is executed, adorned with the values of the inputs expressed as key/value pairs, where the key is the Id of the input. If `data` is expressed as a string, input values are not sent to the Bot.
		*/
		data;
		/**
		* The Ids of the inputs associated with the Action.Submit. When the action is executed, the values of the associated inputs are sent to the Bot. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		associatedInputs;
		/**
		* Controls if the action is enabled only if at least one required input has been filled by the user.
		*/
		conditionallyEnabled = false;
		/**
		* The verb of the action.
		*/
		verb;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ExecuteAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withData(data) {
			this.data = data;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withConditionallyEnabled(conditionallyEnabled = true) {
			this.conditionallyEnabled = conditionallyEnabled;
			return this;
		}
		withVerb(verb) {
			this.verb = verb;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isInsertImageAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.InsertImage";
	}
	var InsertImageAction = class InsertImageAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.InsertImage**.
		*/
		type = "Action.InsertImage";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The URL of the image to insert.
		*/
		url;
		/**
		* The alternate text for the image.
		*/
		altText;
		/**
		* The position at which to insert the image.
		*/
		insertPosition = "Selection";
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new InsertImageAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withInsertPosition(insertPosition) {
			this.insertPosition = insertPosition;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isOpenUrlAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.OpenUrl";
	}
	var OpenUrlAction = class OpenUrlAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.OpenUrl**.
		*/
		type = "Action.OpenUrl";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The URL to open.
		*/
		url;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(url, options = {}) {
			Object.assign(this, options);
			this.url = url;
		}
		static from(options) {
			return new OpenUrlAction(options.url, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isOpenUrlDialogAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.OpenUrlDialog";
	}
	var OpenUrlDialogAction = class OpenUrlDialogAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.OpenUrlDialog**.
		*/
		type = "Action.OpenUrlDialog";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The title of the dialog to be displayed in the dialog header.
		*/
		dialogTitle;
		/**
		* The height of the dialog. To define height as a number of pixels, use the <number>px format.
		*/
		dialogHeight;
		/**
		* The width of the dialog. To define width as a number of pixels, use the <number>px format.
		*/
		dialogWidth;
		/**
		* The URL to open.
		*/
		url;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new OpenUrlDialogAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withDialogTitle(dialogTitle) {
			this.dialogTitle = dialogTitle;
			return this;
		}
		withDialogHeight(dialogHeight) {
			this.dialogHeight = dialogHeight;
			return this;
		}
		withDialogWidth(dialogWidth) {
			this.dialogWidth = dialogWidth;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isResetInputsAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ResetInputs";
	}
	var ResetInputsAction = class ResetInputsAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ResetInputs**.
		*/
		type = "Action.ResetInputs";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The Ids of the inputs that should be reset.
		*/
		targetInputIds;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResetInputsAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withTargetInputIds(...targetInputIds) {
			this.targetInputIds = targetInputIds;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isSubmitAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Submit";
	}
	var SubmitAction = class SubmitAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Submit**.
		*/
		type = "Action.Submit";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The data to send to the Bot when the action is executed. When expressed as an object, `data` is sent back to the Bot when the action is executed, adorned with the values of the inputs expressed as key/value pairs, where the key is the Id of the input. If `data` is expressed as a string, input values are not sent to the Bot.
		*/
		data;
		/**
		* The Ids of the inputs associated with the Action.Submit. When the action is executed, the values of the associated inputs are sent to the Bot. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		associatedInputs;
		/**
		* Controls if the action is enabled only if at least one required input has been filled by the user.
		*/
		conditionallyEnabled = false;
		/**
		* Teams-specific metadata associated with the action.
		*/
		msteams;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new SubmitAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withData(data) {
			this.data = data;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withConditionallyEnabled(conditionallyEnabled = true) {
			this.conditionallyEnabled = conditionallyEnabled;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isToggleVisibilityAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ToggleVisibility";
	}
	var ToggleVisibilityAction = class ToggleVisibilityAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ToggleVisibility**.
		*/
		type = "Action.ToggleVisibility";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The Ids of the elements to toggle the visibility of.
		*/
		targetElements;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ToggleVisibilityAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withTargetElements(...targetElements) {
			this.targetElements = targetElements;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var ThemedUrl = class ThemedUrl {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The theme this URL applies to.
		*/
		theme = "Light";
		/**
		* The URL to use for the associated theme.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ThemedUrl(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTheme(theme) {
			this.theme = theme;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	var TargetElement = class TargetElement {
		/**
		* The Id of the element to change the visibility of.
		*/
		elementId;
		/**
		* The new visibility state of the element.
		*/
		isVisible;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TargetElement(options);
		}
		withElementId(elementId) {
			this.elementId = elementId;
			return this;
		}
		withIsVisible(isVisible) {
			this.isVisible = isVisible;
			return this;
		}
	};
	function isShowCardAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ShowCard";
	}
	var ShowCardAction = class ShowCardAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ShowCard**.
		*/
		type = "Action.ShowCard";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The card that should be displayed when the action is executed.
		*/
		card;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ShowCardAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withCard(card) {
			this.card = card;
			return this;
		}
	};
	function isPopoverAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Popover";
	}
	var PopoverAction = class PopoverAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Popover**.
		*/
		type = "Action.Popover";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The content of the popover, which can be any element.
		*/
		content;
		/**
		* Controls if an arrow should be displayed towards the element that triggered the popover.
		*/
		displayArrow = true;
		/**
		* Controls where the popover should be displayed with regards to the element that triggered it.
		*/
		position = "Above";
		/**
		* The maximum width of the popover in pixels, in the `<number>px` format
		*/
		maxPopoverWidth;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PopoverAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withContent(content) {
			this.content = content;
			return this;
		}
		withDisplayArrow(displayArrow = false) {
			this.displayArrow = displayArrow;
			return this;
		}
		withPosition(position) {
			this.position = position;
			return this;
		}
		withMaxPopoverWidth(maxPopoverWidth) {
			this.maxPopoverWidth = maxPopoverWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isActionSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ActionSet";
	}
	var ActionSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ActionSet**.
		*/
		type = "ActionSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The actions in the set.
		*/
		actions;
		constructor(...actions) {
			this.actions = actions;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withActions(...actions) {
			this.actions = actions;
			return this;
		}
	};
	function isContainer(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Container";
	}
	var Container = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Container**.
		*/
		type = "Container";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the container.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isStackLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.Stack";
	}
	var StackLayout = class StackLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.Stack**.
		*/
		type = "Layout.Stack";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
	};
	function isFlowLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.Flow";
	}
	var FlowLayout = class FlowLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.Flow**.
		*/
		type = "Layout.Flow";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		/**
		* Controls how the content of the container should be horizontally aligned.
		*/
		horizontalItemsAlignment = "Center";
		/**
		* Controls how the content of the container should be vertically aligned.
		*/
		verticalItemsAlignment = "Top";
		/**
		* Controls how item should fit inside the container.
		*/
		itemFit = "Fit";
		/**
		* The minimum width, in pixels, of each item, in the `<number>px` format. Should not be used if itemWidth is set.
		*/
		minItemWidth;
		/**
		* The maximum width, in pixels, of each item, in the `<number>px` format. Should not be used if itemWidth is set.
		*/
		maxItemWidth;
		/**
		* The width, in pixels, of each item, in the `<number>px` format. Should not be used if maxItemWidth and/or minItemWidth are set.
		*/
		itemWidth;
		/**
		* The space between items.
		*/
		columnSpacing = "Default";
		/**
		* The space between rows of items.
		*/
		rowSpacing = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new FlowLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withHorizontalItemsAlignment(horizontalItemsAlignment) {
			this.horizontalItemsAlignment = horizontalItemsAlignment;
			return this;
		}
		withVerticalItemsAlignment(verticalItemsAlignment) {
			this.verticalItemsAlignment = verticalItemsAlignment;
			return this;
		}
		withItemFit(itemFit) {
			this.itemFit = itemFit;
			return this;
		}
		withMinItemWidth(minItemWidth) {
			this.minItemWidth = minItemWidth;
			return this;
		}
		withMaxItemWidth(maxItemWidth) {
			this.maxItemWidth = maxItemWidth;
			return this;
		}
		withItemWidth(itemWidth) {
			this.itemWidth = itemWidth;
			return this;
		}
		withColumnSpacing(columnSpacing) {
			this.columnSpacing = columnSpacing;
			return this;
		}
		withRowSpacing(rowSpacing) {
			this.rowSpacing = rowSpacing;
			return this;
		}
	};
	function isAreaGridLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.AreaGrid";
	}
	var AreaGridLayout = class AreaGridLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.AreaGrid**.
		*/
		type = "Layout.AreaGrid";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		/**
		* The columns in the grid layout, defined as a percentage of the available width or in pixels using the `<number>px` format.
		*/
		columns;
		/**
		* The areas in the grid layout.
		*/
		areas;
		/**
		* The space between columns.
		*/
		columnSpacing = "Default";
		/**
		* The space between rows.
		*/
		rowSpacing = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new AreaGridLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
		withAreas(...areas) {
			this.areas = areas;
			return this;
		}
		withColumnSpacing(columnSpacing) {
			this.columnSpacing = columnSpacing;
			return this;
		}
		withRowSpacing(rowSpacing) {
			this.rowSpacing = rowSpacing;
			return this;
		}
	};
	var GridArea = class GridArea {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the area. To place an element in this area, set its `grid.area` property to match the name of the area.
		*/
		name;
		/**
		* The start column index of the area. Column indices start at 1.
		*/
		column = 1;
		/**
		* Defines how many columns the area should span.
		*/
		columnSpan = 1;
		/**
		* The start row index of the area. Row indices start at 1.
		*/
		row = 1;
		/**
		* Defines how many rows the area should span.
		*/
		rowSpan = 1;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GridArea(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withColumn(column) {
			this.column = column;
			return this;
		}
		withColumnSpan(columnSpan) {
			this.columnSpan = columnSpan;
			return this;
		}
		withRow(row) {
			this.row = row;
			return this;
		}
		withRowSpan(rowSpan) {
			this.rowSpan = rowSpan;
			return this;
		}
	};
	var BackgroundImage = class BackgroundImage {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* Controls how the image should fill the area.
		*/
		fillMode = "Cover";
		/**
		* Controls how the image should be aligned if it must be cropped or if using repeat fill mode.
		*/
		horizontalAlignment = "Left";
		/**
		* Controls how the image should be aligned if it must be cropped or if using repeat fill mode.
		*/
		verticalAlignment = "Top";
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new BackgroundImage(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFillMode(fillMode) {
			this.fillMode = fillMode;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withVerticalAlignment(verticalAlignment) {
			this.verticalAlignment = verticalAlignment;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
	};
	function isColumnSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ColumnSet";
	}
	var ColumnSet = class ColumnSet {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ColumnSet**.
		*/
		type = "ColumnSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* The minimum width of the column set. `auto` will automatically adjust the column set's minimum width according to its content and using the `<number>px` format will give the column set an explicit minimum width in pixels. A scrollbar will be displayed if the available width is less than the specified minimum width.
		*/
		minWidth;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The columns in the set.
		*/
		columns;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ColumnSet(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withMinWidth(minWidth) {
			this.minWidth = minWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
	};
	function isMedia(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Media";
	}
	var Media = class Media {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Media**.
		*/
		type = "Media";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The sources for the media. For YouTube, Dailymotion and Vimeo, only one source can be specified.
		*/
		sources;
		/**
		* The caption sources for the media. Caption sources are not used for YouTube, Dailymotion or Vimeo sources.
		*/
		captionSources;
		/**
		* The URL of the poster image to display.
		*/
		poster;
		/**
		* The alternate text for the media, used for accessibility purposes.
		*/
		altText;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Media(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSources(...sources) {
			this.sources = sources;
			return this;
		}
		withCaptionSources(...captionSources) {
			this.captionSources = captionSources;
			return this;
		}
		withPoster(poster) {
			this.poster = poster;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var MediaSource = class MediaSource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The MIME type of the source.
		*/
		mimeType;
		/**
		* The URL of the source.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MediaSource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMimeType(mimeType) {
			this.mimeType = mimeType;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	var CaptionSource = class CaptionSource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The MIME type of the source.
		*/
		mimeType;
		/**
		* The URL of the source.
		*/
		url;
		/**
		* The label of this caption source.
		*/
		label;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CaptionSource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMimeType(mimeType) {
			this.mimeType = mimeType;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
	};
	function isRichTextBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "RichTextBlock";
	}
	var RichTextBlock = class RichTextBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **RichTextBlock**.
		*/
		type = "RichTextBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The Id of the input the RichTextBlock should act as the label of.
		*/
		labelFor;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The inlines making up the rich text block.
		*/
		inlines;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RichTextBlock(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabelFor(labelFor) {
			this.labelFor = labelFor;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withInlines(...inlines) {
			this.inlines = inlines;
			return this;
		}
	};
	function isTable(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Table";
	}
	var Table = class Table {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Table**.
		*/
		type = "Table";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The columns in the table.
		*/
		columns;
		/**
		* The minimum width of the table in pixels. `auto` will automatically adjust the table's minimum width according to its content and using the `<number>px` format will give the table an explicit minimum width in pixels. A scrollbar will be displayed if the available width is less than the specified minimum width.
		*/
		minWidth;
		/**
		* Controls whether the first row of the table should be treated as a header.
		*/
		firstRowAsHeaders = true;
		/**
		* Controls if grid lines should be displayed.
		*/
		showGridLines = true;
		/**
		* The style of the grid lines between cells.
		*/
		gridStyle;
		/**
		* Controls how the content of every cell in the table should be horizontally aligned by default.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the table should be vertically aligned by default.
		*/
		verticalCellContentAlignment;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The rows of the table.
		*/
		rows;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Table(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
		withMinWidth(minWidth) {
			this.minWidth = minWidth;
			return this;
		}
		withFirstRowAsHeaders(firstRowAsHeaders = false) {
			this.firstRowAsHeaders = firstRowAsHeaders;
			return this;
		}
		withShowGridLines(showGridLines = false) {
			this.showGridLines = showGridLines;
			return this;
		}
		withGridStyle(gridStyle) {
			this.gridStyle = gridStyle;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withRows(...rows) {
			this.rows = rows;
			return this;
		}
	};
	var ColumnDefinition = class ColumnDefinition {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls how the content of every cell in the table should be horizontally aligned by default. This property overrides the horizontalCellContentAlignment property of the table.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the column should be vertically aligned by default. This property overrides the verticalCellContentAlignment property of the table.
		*/
		verticalCellContentAlignment;
		/**
		* The width of the column in the table. If expressed as a number, represents the relative weight of the column in the table. If expressed as a string, `auto` will automatically adjust the column's width according to its content and using the `<number>px` format will give the column an explicit width in pixels.
		*/
		width;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ColumnDefinition(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
	};
	function isTextBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TextBlock";
	}
	var TextBlock = class TextBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TextBlock**.
		*/
		type = "TextBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display. A subset of markdown is supported.
		*/
		text;
		/**
		* The size of the text.
		*/
		size;
		/**
		* The weight of the text.
		*/
		weight;
		/**
		* The color of the text.
		*/
		color;
		/**
		* Controls whether the text should be renderer using a subtler variant of the select color.
		*/
		isSubtle;
		/**
		* The type of font to use for rendering.
		*/
		fontType;
		/**
		* Controls if the text should wrap.
		*/
		wrap = false;
		/**
		* The maximum number of lines to display.
		*/
		maxLines;
		/**
		* The style of the text.
		*/
		style;
		/**
		* The Id of the input the TextBlock should act as the label of.
		*/
		labelFor;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(text, options = {}) {
			Object.assign(this, options);
			this.text = text;
		}
		static from(options) {
			return new TextBlock(options.text, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWeight(weight) {
			this.weight = weight;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withIsSubtle(isSubtle) {
			this.isSubtle = isSubtle;
			return this;
		}
		withFontType(fontType) {
			this.fontType = fontType;
			return this;
		}
		withWrap(wrap = true) {
			this.wrap = wrap;
			return this;
		}
		withMaxLines(maxLines) {
			this.maxLines = maxLines;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLabelFor(labelFor) {
			this.labelFor = labelFor;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isFactSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "FactSet";
	}
	var FactSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **FactSet**.
		*/
		type = "FactSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The facts in the set.
		*/
		facts;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...facts) {
			this.facts = facts;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withFacts(...facts) {
			this.facts = facts;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var Fact = class Fact {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The fact's title.
		*/
		title;
		/**
		* The fact's value.
		*/
		value;
		constructor(title, value, options = {}) {
			Object.assign(this, options);
			this.title = title;
			this.value = value;
		}
		static from(options) {
			return new Fact(options.title, options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isImageSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ImageSet";
	}
	var ImageSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ImageSet**.
		*/
		type = "ImageSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The images in the set.
		*/
		images;
		/**
		* The size to use to render all images in the set.
		*/
		imageSize = "Medium";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...images) {
			this.images = images;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withImages(...images) {
			this.images = images;
			return this;
		}
		withImageSize(imageSize) {
			this.imageSize = imageSize;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isImage(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Image";
	}
	var Image = class Image {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Image**.
		*/
		type = "Image";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* The alternate text for the image, used for accessibility purposes.
		*/
		altText;
		/**
		* The background color of the image.
		*/
		backgroundColor;
		/**
		* The style of the image.
		*/
		style = "Default";
		/**
		* The size of the image.
		*/
		size = "Auto";
		/**
		* The width of the image.
		*/
		width = "auto";
		/**
		* An Action that will be invoked when the image is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* Controls if the image can be expanded to full screen.
		*/
		allowExpand = false;
		/**
		* Teams-specific metadata associated with the image.
		*/
		msteams;
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		/**
		* Controls how the image should be fitted inside its bounding box. imageFit is only meaningful when both the width and height properties are set. When fitMode is set to contain, the default style is always used.
		*/
		fitMode = "Fill";
		/**
		* Controls the horizontal position of the image within its bounding box. horizontalContentAlignment is only meaningful when both the width and height properties are set and fitMode is set to either cover or contain.
		*/
		horizontalContentAlignment = "Left";
		/**
		* Controls the vertical position of the image within its bounding box. verticalContentAlignment is only meaningful when both the width and height properties are set and fitMode is set to either cover or contain.
		*/
		verticalContentAlignment = "Top";
		/**
		* The height of the image.
		*/
		height = "auto";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(url, options = {}) {
			Object.assign(this, options);
			this.url = url;
		}
		static from(options) {
			return new Image(options.url, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withBackgroundColor(backgroundColor) {
			this.backgroundColor = backgroundColor;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withAllowExpand(allowExpand = true) {
			this.allowExpand = allowExpand;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
		withFitMode(fitMode) {
			this.fitMode = fitMode;
			return this;
		}
		withHorizontalContentAlignment(horizontalContentAlignment) {
			this.horizontalContentAlignment = horizontalContentAlignment;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var TeamsImageProperties = class TeamsImageProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls if the image is expandable in Teams. This property is equivalent to the Image.allowExpand property.
		*/
		allowExpand;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsImageProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withAllowExpand(allowExpand) {
			this.allowExpand = allowExpand;
			return this;
		}
	};
	function isTextInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Text";
	}
	var TextInput = class TextInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Text**.
		*/
		type = "Input.Text";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The maximum length of the text in the input.
		*/
		maxLength;
		/**
		* Controls if the input should allow multiple lines of text.
		*/
		isMultiline = false;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The style of the input.
		*/
		style = "Text";
		/**
		* The action that should be displayed as a button alongside the input. Action.ShowCard is not supported.
		*/
		inlineAction;
		/**
		* The regular expression to validate the input.
		*/
		regex;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TextInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMaxLength(maxLength) {
			this.maxLength = maxLength;
			return this;
		}
		withIsMultiline(isMultiline = true) {
			this.isMultiline = isMultiline;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withInlineAction(inlineAction) {
			this.inlineAction = inlineAction;
			return this;
		}
		withRegex(regex) {
			this.regex = regex;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isDateInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Date";
	}
	var DateInput = class DateInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Date**.
		*/
		type = "Input.Date";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input, in the `YYYY-MM-DD` format.
		*/
		value;
		/**
		* The text to display as a placeholder when the user has not selected a date.
		*/
		placeholder;
		/**
		* The minimum date that can be selected.
		*/
		min;
		/**
		* The maximum date that can be selected.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DateInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isTimeInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Time";
	}
	var TimeInput = class TimeInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Time**.
		*/
		type = "Input.Time";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input, in the `HH:MM` format.
		*/
		value;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The minimum time that can be selected, in the `HH:MM` format.
		*/
		min;
		/**
		* The maximum time that can be selected, in the `HH:MM` format.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TimeInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isNumberInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Number";
	}
	var NumberInput = class NumberInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Number**.
		*/
		type = "Input.Number";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The minimum value that can be entered.
		*/
		min;
		/**
		* The maximum value that can be entered.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new NumberInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isToggleInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Toggle";
	}
	var ToggleInput = class ToggleInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Toggle**.
		*/
		type = "Input.Toggle";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value = "false";
		/**
		* The title (caption) to display next to the toggle.
		*/
		title;
		/**
		* The value to send to the Bot when the toggle is on.
		*/
		valueOn = "true";
		/**
		* The value to send to the Bot when the toggle is off.
		*/
		valueOff = "false";
		/**
		* Controls if the title should wrap.
		*/
		wrap = true;
		/**
		* Controls whether the title is visually displayed. When set to false, the title is hidden from view but remains accessible to screen readers for accessibility purposes.
		*/
		showTitle = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(title, options = {}) {
			Object.assign(this, options);
			this.title = title;
		}
		static from(options) {
			return new ToggleInput(options.title, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValueOn(valueOn) {
			this.valueOn = valueOn;
			return this;
		}
		withValueOff(valueOff) {
			this.valueOff = valueOff;
			return this;
		}
		withWrap(wrap = false) {
			this.wrap = wrap;
			return this;
		}
		withShowTitle(showTitle = false) {
			this.showTitle = showTitle;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isChoiceSetInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.ChoiceSet";
	}
	var ChoiceSetInput = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.ChoiceSet**.
		*/
		type = "Input.ChoiceSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The choices associated with the input.
		*/
		choices;
		/**
		* A Data.Query object that defines the dataset from which to dynamically fetch the choices for the input.
		*/
		"choices.data";
		/**
		* Controls whether the input should be displayed as a dropdown (compact) or a list of radio buttons or checkboxes (expanded).
		*/
		style = "compact";
		/**
		* Controls whether multiple choices can be selected.
		*/
		isMultiSelect = false;
		/**
		* The text to display as a placeholder when the user has not entered any value.
		*/
		placeholder;
		/**
		* Controls if choice titles should wrap.
		*/
		wrap = true;
		/**
		* Controls whether choice items are arranged in multiple columns in expanded mode, or in a single column. Default is false.
		*/
		useMultipleColumns = false;
		/**
		* The minimum width, in pixels, for each column when using a multi-column layout. This ensures that choice items remain readable even when horizontal space is limited. Default is 100 pixels.
		*/
		minColumnWidth;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...choices) {
			this.choices = choices;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withChoices(...choices) {
			this.choices = choices;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withIsMultiSelect(isMultiSelect = true) {
			this.isMultiSelect = isMultiSelect;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withWrap(wrap = false) {
			this.wrap = wrap;
			return this;
		}
		withUseMultipleColumns(useMultipleColumns = true) {
			this.useMultipleColumns = useMultipleColumns;
			return this;
		}
		withMinColumnWidth(minColumnWidth) {
			this.minColumnWidth = minColumnWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var Choice = class Choice {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The text to display for the choice.
		*/
		title;
		/**
		* The value associated with the choice, as sent to the Bot when an Action.Submit or Action.Execute is invoked
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Choice(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isQueryData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Data.Query";
	}
	var QueryData = class QueryData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Data.Query**.
		*/
		type = "Data.Query";
		/**
		* The dataset from which to fetch the data.
		*/
		dataset;
		/**
		* Controls which inputs are associated with the Data.Query. When a Data.Query is executed, the values of the associated inputs are sent to the Bot, allowing it to perform filtering operations based on the user's input.
		*/
		associatedInputs;
		/**
		* The maximum number of data items that should be returned by the query. Card authors should not specify this property in their card payload. It is determined by the client and sent to the Bot to enable pagination.
		*/
		count;
		/**
		* The number of data items to be skipped by the query. Card authors should not specify this property in their card payload. It is determined by the client and sent to the Bot to enable pagination.
		*/
		skip;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new QueryData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withDataset(dataset) {
			this.dataset = dataset;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withCount(count) {
			this.count = count;
			return this;
		}
		withSkip(skip) {
			this.skip = skip;
			return this;
		}
	};
	function isRatingInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Rating";
	}
	var RatingInput = class RatingInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Rating**.
		*/
		type = "Input.Rating";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The number of stars to display.
		*/
		max = 5;
		/**
		* Controls if the user can select half stars.
		*/
		allowHalfSteps = false;
		/**
		* The size of the stars.
		*/
		size = "Large";
		/**
		* The color of the stars.
		*/
		color = "Neutral";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RatingInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withAllowHalfSteps(allowHalfSteps = true) {
			this.allowHalfSteps = allowHalfSteps;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isRating(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Rating";
	}
	var Rating = class Rating {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Rating**.
		*/
		type = "Rating";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The value of the rating. Must be between 0 and max.
		*/
		value;
		/**
		* The number of "votes" associated with the rating.
		*/
		count;
		/**
		* The number of stars to display.
		*/
		max = 5;
		/**
		* The size of the stars.
		*/
		size = "Large";
		/**
		* The color of the stars.
		*/
		color = "Neutral";
		/**
		* The style of the stars.
		*/
		style = "Default";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Rating(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withCount(count) {
			this.count = count;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isCompoundButton(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CompoundButton";
	}
	var CompoundButton = class CompoundButton {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CompoundButton**.
		*/
		type = "CompoundButton";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The icon to show on the button.
		*/
		icon;
		/**
		* The badge to show on the button.
		*/
		badge;
		/**
		* The title of the button.
		*/
		title;
		/**
		* The description text of the button.
		*/
		description;
		/**
		* An Action that will be invoked when the button is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CompoundButton(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withIcon(icon) {
			this.icon = icon;
			return this;
		}
		withBadge(badge) {
			this.badge = badge;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withDescription(description) {
			this.description = description;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var IconInfo = class IconInfo {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the icon to display.
		*/
		name;
		/**
		* The size of the icon.
		*/
		size = "xSmall";
		/**
		* The style of the icon.
		*/
		style = "Regular";
		/**
		* The color of the icon.
		*/
		color = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new IconInfo(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isIcon(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Icon";
	}
	var Icon = class Icon {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Icon**.
		*/
		type = "Icon";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The name of the icon to display.
		*/
		name;
		/**
		* The size of the icon.
		*/
		size = "Standard";
		/**
		* The style of the icon.
		*/
		style = "Regular";
		/**
		* The color of the icon.
		*/
		color = "Default";
		/**
		* An Action that will be invoked when the icon is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(name, options = {}) {
			Object.assign(this, options);
			this.name = name;
		}
		static from(options) {
			return new Icon(options.name, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isCarousel(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Carousel";
	}
	var Carousel = class Carousel {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Carousel**.
		*/
		type = "Carousel";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Controls the type of animation to use to navigate between pages.
		*/
		pageAnimation = "Slide";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The pages in the carousel.
		*/
		pages;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Carousel(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withPageAnimation(pageAnimation) {
			this.pageAnimation = pageAnimation;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withPages(...pages) {
			this.pages = pages;
			return this;
		}
	};
	function isBadge(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Badge";
	}
	var Badge = class Badge {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Badge**.
		*/
		type = "Badge";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display.
		*/
		text;
		/**
		* The name of an icon from the [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) to display, in the `<icon-name>[,regular|filled]` format. If the style is not specified, the regular style is used.
		*/
		icon;
		/**
		* Controls the position of the icon.
		*/
		iconPosition = "Before";
		/**
		* Controls the strength of the background color.
		*/
		appearance = "Filled";
		/**
		* The size of the badge.
		*/
		size = "Medium";
		/**
		* Controls the shape of the badge.
		*/
		shape = "Circular";
		/**
		* The style of the badge.
		*/
		style = "Default";
		/**
		* Controls the tooltip text to display when the badge is hovered over.
		*/
		tooltip;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Badge(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withIcon(icon) {
			this.icon = icon;
			return this;
		}
		withIconPosition(iconPosition) {
			this.iconPosition = iconPosition;
			return this;
		}
		withAppearance(appearance) {
			this.appearance = appearance;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withShape(shape) {
			this.shape = shape;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isProgressRing(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ProgressRing";
	}
	var ProgressRing = class ProgressRing {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ProgressRing**.
		*/
		type = "ProgressRing";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the progress ring.
		*/
		label;
		/**
		* Controls the relative position of the label to the progress ring.
		*/
		labelPosition = "Below";
		/**
		* The size of the progress ring.
		*/
		size = "Medium";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ProgressRing(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withLabelPosition(labelPosition) {
			this.labelPosition = labelPosition;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isProgressBar(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ProgressBar";
	}
	var ProgressBar = class ProgressBar {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ProgressBar**.
		*/
		type = "ProgressBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The value of the progress bar. Must be between 0 and max.
		*/
		value;
		/**
		* The maximum value of the progress bar.
		*/
		max = 100;
		/**
		* The color of the progress bar. `color` has no effect when the `ProgressBar` is in indeterminate mode, in which case the "accent" color is always used.
		*/
		color = "Accent";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ProgressBar(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isDonutChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Donut";
	}
	var DonutChart = class DonutChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Donut**.
		*/
		type = "Chart.Donut";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The value that should be displayed in the center of a Donut chart. `value` is ignored for Pie charts.
		*/
		value;
		/**
		* Controls the color of the value displayed in the center of a Donut chart.
		*/
		valueColor;
		/**
		* Controls the thickness of the donut segments. Default is **Thick**.
		*/
		thickness;
		/**
		* Controls whether the outlines of the donut segments are displayed.
		*/
		showOutlines = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DonutChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueColor(valueColor) {
			this.valueColor = valueColor;
			return this;
		}
		withThickness(thickness) {
			this.thickness = thickness;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var DonutChartData = class DonutChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The value associated with the data point.
		*/
		value = 0;
		/**
		* The color to use for the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DonutChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isPieChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Pie";
	}
	var PieChart = class PieChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Pie**.
		*/
		type = "Chart.Pie";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The value that should be displayed in the center of a Donut chart. `value` is ignored for Pie charts.
		*/
		value;
		/**
		* Controls the color of the value displayed in the center of a Donut chart.
		*/
		valueColor;
		/**
		* Controls the thickness of the donut segments. Default is **Thick**.
		*/
		thickness;
		/**
		* Controls whether the outlines of the donut segments are displayed.
		*/
		showOutlines = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PieChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueColor(valueColor) {
			this.valueColor = valueColor;
			return this;
		}
		withThickness(thickness) {
			this.thickness = thickness;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isGroupedVerticalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.VerticalBar.Grouped";
	}
	var GroupedVerticalBarChart = class GroupedVerticalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.VerticalBar.Grouped**.
		*/
		type = "Chart.VerticalBar.Grouped";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* Controls if bars in the chart should  be displayed as stacks instead of groups.
		*
		* **Note:** stacked vertical bar charts do not support custom Y ranges nor negative Y values.
		*/
		stacked = false;
		/**
		* The data points in a series.
		*/
		data;
		/**
		* Controls if values should be displayed on each bar.
		*/
		showBarValues = false;
		/**
		* The requested minimum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*
		* `yMin` is ignored if `stacked` is set to `true`.
		*/
		yMin;
		/**
		* The requested maximum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*
		* `yMax` is ignored if `stacked` is set to `true`.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GroupedVerticalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withStacked(stacked = true) {
			this.stacked = stacked;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withShowBarValues(showBarValues = true) {
			this.showBarValues = showBarValues;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var GroupedVerticalBarChartData = class GroupedVerticalBarChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The data points in the series.
		*/
		values;
		/**
		* The color to use for all data points in the series. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GroupedVerticalBarChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValues(...values) {
			this.values = values;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	var BarChartDataValue = class BarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new BarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
	};
	function isVerticalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.VerticalBar";
	}
	var VerticalBarChart = class VerticalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.VerticalBar**.
		*/
		type = "Chart.VerticalBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* Controls if the bar values should be displayed.
		*/
		showBarValues = false;
		/**
		* The requested minimum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*/
		yMin;
		/**
		* The requested maximum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new VerticalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withShowBarValues(showBarValues = true) {
			this.showBarValues = showBarValues;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var VerticalBarChartDataValue = class VerticalBarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		/**
		* The color to use for the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new VerticalBarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isHorizontalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.HorizontalBar";
	}
	var HorizontalBarChart = class HorizontalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.HorizontalBar**.
		*/
		type = "Chart.HorizontalBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data points in the chart.
		*/
		data;
		/**
		* Controls how the chart should be visually laid out.
		*/
		displayMode = "AbsoluteWithAxis";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HorizontalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withDisplayMode(displayMode) {
			this.displayMode = displayMode;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var HorizontalBarChartDataValue = class HorizontalBarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		/**
		* The color of the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HorizontalBarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isStackedHorizontalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.HorizontalBar.Stacked";
	}
	var StackedHorizontalBarChart = class StackedHorizontalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.HorizontalBar.Stacked**.
		*/
		type = "Chart.HorizontalBar.Stacked";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var StackedHorizontalBarChartData = class StackedHorizontalBarChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The title of the series.
		*/
		title;
		/**
		* The data points in the series.
		*/
		data;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
	};
	var StackedHorizontalBarChartDataPoint = class StackedHorizontalBarChartDataPoint {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend associated with the data point.
		*/
		legend;
		/**
		* The value of the data point.
		*/
		value = 0;
		/**
		* The color to use to render the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChartDataPoint(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isLineChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Line";
	}
	var LineChart = class LineChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Line**.
		*/
		type = "Chart.Line";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data point series in the line chart.
		*/
		data;
		/**
		* The maximum y range.
		*/
		yMin;
		/**
		* The minimum y range.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var LineChartData = class LineChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The data points in the series.
		*/
		values;
		/**
		* The color all data points in the series. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValues(...values) {
			this.values = values;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	var LineChartValue = class LineChartValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*
		* If all x values of the x [Chart.Line](https://adaptivecards.microsoft.com/?topic=Chart.Line) are expressed as a number, or if all x values are expressed as a date string in the `YYYY-MM-DD` format, the chart will be rendered as a time series chart, i.e. x axis values will span across the minimum x value to maximum x value range.
		*
		* Otherwise, if x values are represented as a mix of numbers and strings or if at least one x value isn't in the `YYYY-MM-DD` format, the chart will be rendered as a categorical chart, i.e. x axis values will be displayed as categories.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChartValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
	};
	function isGaugeChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Gauge";
	}
	var GaugeChart = class GaugeChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Gauge**.
		*/
		type = "Chart.Gauge";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The minimum value of the gauge.
		*/
		min = 0;
		/**
		* The maximum value of the gauge.
		*/
		max;
		/**
		* The sub-label of the gauge.
		*/
		subLabel;
		/**
		* Controls whether the min/max values should be displayed.
		*/
		showMinMax = true;
		/**
		* Controls whether the gauge's needle is displayed. Default is **true**.
		*/
		showNeedle = true;
		/**
		* Controls whether the outlines of the gauge segments are displayed.
		*/
		showOutlines = true;
		/**
		* The segments to display in the gauge.
		*/
		segments;
		/**
		* The value of the gauge.
		*/
		value = 0;
		/**
		* The format used to display the gauge's value.
		*/
		valueFormat = "Percentage";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GaugeChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withSubLabel(subLabel) {
			this.subLabel = subLabel;
			return this;
		}
		withShowMinMax(showMinMax = false) {
			this.showMinMax = showMinMax;
			return this;
		}
		withShowNeedle(showNeedle = false) {
			this.showNeedle = showNeedle;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withSegments(...segments) {
			this.segments = segments;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueFormat(valueFormat) {
			this.valueFormat = valueFormat;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var GaugeChartLegend = class GaugeChartLegend {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The size of the segment.
		*/
		size = 0;
		/**
		* The legend text associated with the segment.
		*/
		legend;
		/**
		* The color to use for the segment. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GaugeChartLegend(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isCodeBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CodeBlock";
	}
	var CodeBlock = class CodeBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CodeBlock**.
		*/
		type = "CodeBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The code snippet to display.
		*/
		codeSnippet;
		/**
		* The language the code snippet is expressed in.
		*/
		language = "PlainText";
		/**
		* A number that represents the line in the file from where the code snippet was extracted.
		*/
		startLineNumber = 1;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CodeBlock(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withCodeSnippet(codeSnippet) {
			this.codeSnippet = codeSnippet;
			return this;
		}
		withLanguage(language) {
			this.language = language;
			return this;
		}
		withStartLineNumber(startLineNumber) {
			this.startLineNumber = startLineNumber;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isComUserMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/user";
	}
	var ComUserMicrosoftGraphComponent = class ComUserMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/user**.
		*/
		name = "graph.microsoft.com/user";
		/**
		* The properties of the Persona component.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComUserMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var PersonaProperties = class PersonaProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of the persona.
		*/
		id;
		/**
		* The UPN of the persona.
		*/
		userPrincipalName;
		/**
		* The display name of the persona.
		*/
		displayName;
		/**
		* Defines the style of the icon for the persona.
		*/
		iconStyle;
		/**
		* Defines how the persona should be displayed.
		*/
		style;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PersonaProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withUserPrincipalName(userPrincipalName) {
			this.userPrincipalName = userPrincipalName;
			return this;
		}
		withDisplayName(displayName) {
			this.displayName = displayName;
			return this;
		}
		withIconStyle(iconStyle) {
			this.iconStyle = iconStyle;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
	};
	function isComUsersMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/users";
	}
	var ComUsersMicrosoftGraphComponent = class ComUsersMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/users**.
		*/
		name = "graph.microsoft.com/users";
		/**
		* The properties of the PersonaSet component.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComUsersMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var PersonaSetProperties = class PersonaSetProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The users a PersonaSet component should display.
		*/
		users;
		/**
		* Defines the style of the icon for the personas in the set.
		*/
		iconStyle;
		/**
		* Defines how each persona in the set should be displayed.
		*/
		style;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PersonaSetProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withUsers(...users) {
			this.users = users;
			return this;
		}
		withIconStyle(iconStyle) {
			this.iconStyle = iconStyle;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
	};
	function isComResourceMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/resource";
	}
	var ComResourceMicrosoftGraphComponent = class ComResourceMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/resource**.
		*/
		name = "graph.microsoft.com/resource";
		/**
		* The properties of the resource.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComResourceMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var ResourceProperties = class ResourceProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of the resource.
		*/
		id;
		/**
		* The reference to the resource.
		*/
		resourceReference;
		/**
		* The visualization of the resource.
		*/
		resourceVisualization;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResourceProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withResourceReference(resourceReference) {
			this.resourceReference = resourceReference;
			return this;
		}
		withResourceVisualization(resourceVisualization) {
			this.resourceVisualization = resourceVisualization;
			return this;
		}
	};
	var ResourceVisualization = class ResourceVisualization {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The media associated with the resource.
		*/
		media;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResourceVisualization(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMedia(media) {
			this.media = media;
			return this;
		}
	};
	function isComFileMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/file";
	}
	var ComFileMicrosoftGraphComponent = class ComFileMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/file**.
		*/
		name = "graph.microsoft.com/file";
		/**
		* The properties of the file.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComFileMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var FileProperties = class FileProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the file.
		*/
		name;
		/**
		* The file extension.
		*/
		extension;
		/**
		* The URL of the file.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new FileProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withExtension(extension) {
			this.extension = extension;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	function isComEventMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/event";
	}
	var ComEventMicrosoftGraphComponent = class ComEventMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/event**.
		*/
		name = "graph.microsoft.com/event";
		/**
		* The properties of the event.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComEventMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var CalendarEventProperties = class CalendarEventProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The ID of the event.
		*/
		id;
		/**
		* The title of the event.
		*/
		title;
		/**
		* The start date and time of the event.
		*/
		start;
		/**
		* The end date and time of the event.
		*/
		end;
		/**
		* The status of the event.
		*/
		status;
		/**
		* The locations of the event.
		*/
		locations;
		/**
		* The URL of the online meeting.
		*/
		onlineMeetingUrl;
		/**
		* Indicates if the event is all day.
		*/
		isAllDay;
		/**
		* The extension of the event.
		*/
		extension;
		/**
		* The URL of the event.
		*/
		url;
		/**
		* The attendees of the event.
		*/
		attendees;
		/**
		* The organizer of the event.
		*/
		organizer;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CalendarEventProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withStart(start) {
			this.start = start;
			return this;
		}
		withEnd(end) {
			this.end = end;
			return this;
		}
		withStatus(status) {
			this.status = status;
			return this;
		}
		withLocations(...locations) {
			this.locations = locations;
			return this;
		}
		withOnlineMeetingUrl(onlineMeetingUrl) {
			this.onlineMeetingUrl = onlineMeetingUrl;
			return this;
		}
		withIsAllDay(isAllDay) {
			this.isAllDay = isAllDay;
			return this;
		}
		withExtension(extension) {
			this.extension = extension;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAttendees(...attendees) {
			this.attendees = attendees;
			return this;
		}
		withOrganizer(organizer) {
			this.organizer = organizer;
			return this;
		}
	};
	var CalendarEventAttendee = class CalendarEventAttendee {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the attendee.
		*/
		name;
		/**
		* The email address of the attendee.
		*/
		email;
		/**
		* The title of the attendee.
		*/
		title;
		/**
		* The type of the attendee.
		*/
		type;
		/**
		* The status of the attendee.
		*/
		status;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CalendarEventAttendee(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withEmail(email) {
			this.email = email;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withType(type) {
			this.type = type;
			return this;
		}
		withStatus(status) {
			this.status = status;
			return this;
		}
	};
	function isCarouselPage(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CarouselPage";
	}
	var CarouselPage = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CarouselPage**.
		*/
		type = "CarouselPage";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the page.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isTableRow(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TableRow";
	}
	var TableRow = class TableRow {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TableRow**.
		*/
		type = "TableRow";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls how the content of every cell in the row should be horizontally aligned by default. This property overrides the horizontalCellContentAlignment property of the table and columns.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the row should be vertically aligned by default. This property overrides the verticalCellContentAlignment property of the table and columns.
		*/
		verticalCellContentAlignment;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The cells in the row.
		*/
		cells;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TableRow(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withCells(...cells) {
			this.cells = cells;
			return this;
		}
	};
	function isTableCell(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TableCell";
	}
	var TableCell = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TableCell**.
		*/
		type = "TableCell";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The items (elements) in the cell.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isTextRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TextRun";
	}
	var TextRun = class TextRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TextRun**.
		*/
		type = "TextRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display. A subset of markdown is supported.
		*/
		text;
		/**
		* The size of the text.
		*/
		size;
		/**
		* The weight of the text.
		*/
		weight;
		/**
		* The color of the text.
		*/
		color;
		/**
		* Controls whether the text should be renderer using a subtler variant of the select color.
		*/
		isSubtle;
		/**
		* The type of font to use for rendering.
		*/
		fontType;
		/**
		* Controls if the text should be italicized.
		*/
		italic = false;
		/**
		* Controls if the text should be struck through.
		*/
		strikethrough = false;
		/**
		* Controls if the text should be highlighted.
		*/
		highlight = false;
		/**
		* Controls if the text should be underlined.
		*/
		underline = false;
		/**
		* An Action that will be invoked when the text is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(text, options = {}) {
			Object.assign(this, options);
			this.text = text;
		}
		static from(options) {
			return new TextRun(options.text, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWeight(weight) {
			this.weight = weight;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withIsSubtle(isSubtle) {
			this.isSubtle = isSubtle;
			return this;
		}
		withFontType(fontType) {
			this.fontType = fontType;
			return this;
		}
		withItalic(italic = true) {
			this.italic = italic;
			return this;
		}
		withStrikethrough(strikethrough = true) {
			this.strikethrough = strikethrough;
			return this;
		}
		withHighlight(highlight = true) {
			this.highlight = highlight;
			return this;
		}
		withUnderline(underline = true) {
			this.underline = underline;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isIconRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "IconRun";
	}
	var IconRun = class IconRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **IconRun**.
		*/
		type = "IconRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The name of the inline icon to display.
		*/
		name;
		/**
		* The size of the inline icon.
		*/
		size = "Default";
		/**
		* The style of the inline icon.
		*/
		style = "Regular";
		/**
		* The color of the inline icon.
		*/
		color = "Default";
		/**
		* An Action that will be invoked when the inline icon is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new IconRun(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isImageRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ImageRun";
	}
	var ImageRun = class ImageRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ImageRun**.
		*/
		type = "ImageRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* The size of the inline image.
		*/
		size = "Default";
		/**
		* The style of the inline image.
		*/
		style = "Default";
		/**
		* An Action that will be invoked when the image is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ImageRun(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isColumn(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Column";
	}
	var Column = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Optional. If specified, must be **Column**.
		*/
		type = "Column";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The width of the column. If expressed as a number, represents the relative weight of the column in the set. If expressed as a string, `auto` will automatically adjust the column's width according to its content, `stretch` will make the column use the remaining horizontal space (shared with other columns with width set to `stretch`) and using the `<number>px` format will give the column an explicit width in pixels.
		*/
		width;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the column.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	var SubmitActionData = class SubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		/**
		* Defines the optional Teams-specific portion of the action's data.
		*/
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new SubmitActionData(options);
		}
	};
	function isImBackSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "imBack";
	}
	var ImBackSubmitActionData = class ImBackSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **imBack**.
		*/
		type = "imBack";
		/**
		* The value that will be sent to the Bot.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new ImBackSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isInvokeSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "invoke";
	}
	var InvokeSubmitActionData = class InvokeSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **invoke**.
		*/
		type = "invoke";
		/**
		* The object to send to the Bot with the Invoke request. Can be strongly typed as one of the below values to trigger a specific action in Teams.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new InvokeSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isCollabStageInvokeDataValue(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "tab/tabInfoAction";
	}
	var CollabStageInvokeDataValue = class CollabStageInvokeDataValue {
		/**
		* Must be **tab/tabInfoAction**.
		*/
		type = "tab/tabInfoAction";
		/**
		* Provides information about the iFrame content, rendered in the collab stage popout window.
		*/
		tabInfo;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CollabStageInvokeDataValue(options);
		}
		withTabInfo(tabInfo) {
			this.tabInfo = tabInfo;
			return this;
		}
	};
	var TabInfo = class TabInfo {
		/**
		* The name for the content. This will be displayed as the title of the window hosting the iFrame.
		*/
		name;
		/**
		* The URL to open in an iFrame.
		*/
		contentUrl;
		/**
		* The unique entity id for this content (e.g., random UUID).
		*/
		entityId;
		/**
		* An optional website URL to the content, allowing users to open this content in the browser (if they prefer).
		*/
		websiteUrl;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TabInfo(options);
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withContentUrl(contentUrl) {
			this.contentUrl = contentUrl;
			return this;
		}
		withEntityId(entityId) {
			this.entityId = entityId;
			return this;
		}
		withWebsiteUrl(websiteUrl) {
			this.websiteUrl = websiteUrl;
			return this;
		}
	};
	function isMessageBackSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "messageBack";
	}
	var MessageBackSubmitActionData = class MessageBackSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **messageBack**.
		*/
		type = "messageBack";
		/**
		* The text that will be sent to the Bot.
		*/
		text;
		/**
		* The optional text that will be displayed as a new message in the conversation, as if the end-user sent it. `displayText` is not sent to the Bot.
		*/
		displayText;
		/**
		* Optional additional value that will be sent to the Bot. For instance, `value` can encode specific context for the action, such as unique identifiers or a JSON object.
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MessageBackSubmitActionData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withDisplayText(displayText) {
			this.displayText = displayText;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isSigninSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "signin";
	}
	var SigninSubmitActionData = class SigninSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **signin**.
		*/
		type = "signin";
		/**
		* The URL to redirect the end-user for signing in.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new SigninSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isTaskFetchSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "task/fetch";
	}
	var TaskFetchSubmitActionData = class TaskFetchSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **task/fetch**.
		*/
		type = "task/fetch";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TaskFetchSubmitActionData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
	};
	var TeamsSubmitActionProperties = class TeamsSubmitActionProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Defines how feedback is provided to the end-user when the action is executed.
		*/
		feedback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsSubmitActionProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withFeedback(feedback) {
			this.feedback = feedback;
			return this;
		}
	};
	var TeamsSubmitActionFeedback = class TeamsSubmitActionFeedback {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Defines if a feedback message should be displayed after the action is executed.
		*/
		hide;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsSubmitActionFeedback(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withHide(hide) {
			this.hide = hide;
			return this;
		}
	};
	var RefreshDefinition = class RefreshDefinition {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Action.Execute action to invoke to refresh the card.
		*/
		action;
		/**
		* The list of user Ids for which the card will be automatically refreshed. In Teams, in chats or channels with more than 60 users, the card will automatically refresh only for users specified in the userIds list. Other users will have to manually click on a "refresh" button. In contexts with fewer than 60 users, the card will automatically refresh for all users.
		*/
		userIds;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RefreshDefinition(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withAction(action) {
			this.action = action;
			return this;
		}
		withUserIds(...userIds) {
			this.userIds = userIds;
			return this;
		}
	};
	var Authentication = class Authentication {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The text that can be displayed to the end user when prompting them to authenticate.
		*/
		text;
		/**
		* The identifier for registered OAuth connection setting information.
		*/
		connectionName;
		/**
		* The buttons that should be displayed to the user when prompting for authentication. The array MUST contain one button of type “signin”. Other button types are not currently supported.
		*/
		buttons;
		/**
		* Provides information required to enable on-behalf-of single sign-on user authentication.
		*/
		tokenExchangeResource;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Authentication(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withConnectionName(connectionName) {
			this.connectionName = connectionName;
			return this;
		}
		withButtons(...buttons) {
			this.buttons = buttons;
			return this;
		}
		withTokenExchangeResource(tokenExchangeResource) {
			this.tokenExchangeResource = tokenExchangeResource;
			return this;
		}
	};
	var AuthCardButton = class AuthCardButton {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **signin**.
		*/
		type;
		/**
		* The caption of the button.
		*/
		title;
		/**
		* A URL to an image to display alongside the button’s caption.
		*/
		image;
		/**
		* The value associated with the button. The meaning of value depends on the button’s type.
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new AuthCardButton(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withType(type) {
			this.type = type;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withImage(image) {
			this.image = image;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	var TokenExchangeResource = class TokenExchangeResource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The unique identified of this token exchange instance.
		*/
		id;
		/**
		* An application ID or resource identifier with which to exchange a token on behalf of. This property is identity provider- and application-specific.
		*/
		uri;
		/**
		* An identifier for the identity provider with which to attempt a token exchange.
		*/
		providerId;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TokenExchangeResource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withUri(uri) {
			this.uri = uri;
			return this;
		}
		withProviderId(providerId) {
			this.providerId = providerId;
			return this;
		}
	};
	var TeamsCardProperties = class TeamsCardProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls the width of the card in a Teams chat.
		*
		* Note that setting `width` to "full" will not actually stretch the card to the "full width" of the chat pane. It will only make the card wider than when the `width` property isn't set.
		*/
		width;
		/**
		* The Teams-specific entities associated with the card.
		*/
		entities;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsCardProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withEntities(...entities) {
			this.entities = entities;
			return this;
		}
	};
	function isMention(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "mention";
	}
	var Mention = class Mention {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **mention**.
		*/
		type = "mention";
		/**
		* The text that will be substituted with the mention.
		*/
		text;
		/**
		* Defines the entity being mentioned.
		*/
		mentioned;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Mention(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withMentioned(mentioned) {
			this.mentioned = mentioned;
			return this;
		}
	};
	var MentionedEntity = class MentionedEntity {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of a person (typically a Microsoft Entra user Id) or tag.
		*/
		id;
		/**
		* The name of the mentioned entity.
		*/
		name;
		/**
		* The type of the mentioned entity.
		*/
		mentionType = "Person";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MentionedEntity(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withMentionType(mentionType) {
			this.mentionType = mentionType;
			return this;
		}
	};
	var CardMetadata = class CardMetadata {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The URL the card originates from. When `webUrl` is set, the card is dubbed an **Adaptive Card-based Loop Component** and, when pasted in Teams or other Loop Component-capable host applications, the URL will unfurl to the same exact card.
		*/
		webUrl;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CardMetadata(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withWebUrl(webUrl) {
			this.webUrl = webUrl;
			return this;
		}
	};
	var Resources = class Resources {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* String resources that can provide translations in multiple languages. String resources make it possible to craft cards that are automatically localized according to the language settings of the application that displays the card.
		*/
		strings;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Resources(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withStrings(strings) {
			this.strings = strings;
			return this;
		}
	};
	var StringResource = class StringResource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The default value of the string, which is used when no matching localized value is found.
		*/
		defaultValue;
		/**
		* Localized values of the string, where keys represent the locale (e.g. `en-US`) in the `<ISO 639-1>(-<ISO 3166-1 alpha-2>)` format. `<ISO 639-1>` is the 2-letter language code and `<ISO 3166-1 alpha-2>` is the optional 2-letter country code.
		*/
		localizedValues;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StringResource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withDefaultValue(defaultValue) {
			this.defaultValue = defaultValue;
			return this;
		}
		withLocalizedValues(localizedValues) {
			this.localizedValues = localizedValues;
			return this;
		}
	};
	exports.ActionSet = ActionSet;
	exports.AdaptiveCard = AdaptiveCard;
	exports.AreaGridLayout = AreaGridLayout;
	exports.AuthCardButton = AuthCardButton;
	exports.Authentication = Authentication;
	exports.BackgroundImage = BackgroundImage;
	exports.Badge = Badge;
	exports.BarChartDataValue = BarChartDataValue;
	exports.CalendarEventAttendee = CalendarEventAttendee;
	exports.CalendarEventProperties = CalendarEventProperties;
	exports.CaptionSource = CaptionSource;
	exports.CardMetadata = CardMetadata;
	exports.Carousel = Carousel;
	exports.CarouselPage = CarouselPage;
	exports.Choice = Choice;
	exports.ChoiceSetInput = ChoiceSetInput;
	exports.CodeBlock = CodeBlock;
	exports.CollabStageInvokeDataValue = CollabStageInvokeDataValue;
	exports.Column = Column;
	exports.ColumnDefinition = ColumnDefinition;
	exports.ColumnSet = ColumnSet;
	exports.ComEventMicrosoftGraphComponent = ComEventMicrosoftGraphComponent;
	exports.ComFileMicrosoftGraphComponent = ComFileMicrosoftGraphComponent;
	exports.ComResourceMicrosoftGraphComponent = ComResourceMicrosoftGraphComponent;
	exports.ComUserMicrosoftGraphComponent = ComUserMicrosoftGraphComponent;
	exports.ComUsersMicrosoftGraphComponent = ComUsersMicrosoftGraphComponent;
	exports.CompoundButton = CompoundButton;
	exports.Container = Container;
	exports.DateInput = DateInput;
	exports.DonutChart = DonutChart;
	exports.DonutChartData = DonutChartData;
	exports.ExecuteAction = ExecuteAction;
	exports.Fact = Fact;
	exports.FactSet = FactSet;
	exports.FileProperties = FileProperties;
	exports.FlowLayout = FlowLayout;
	exports.GaugeChart = GaugeChart;
	exports.GaugeChartLegend = GaugeChartLegend;
	exports.GridArea = GridArea;
	exports.GroupedVerticalBarChart = GroupedVerticalBarChart;
	exports.GroupedVerticalBarChartData = GroupedVerticalBarChartData;
	exports.HorizontalBarChart = HorizontalBarChart;
	exports.HorizontalBarChartDataValue = HorizontalBarChartDataValue;
	exports.HostCapabilities = HostCapabilities;
	exports.Icon = Icon;
	exports.IconInfo = IconInfo;
	exports.IconRun = IconRun;
	exports.ImBackSubmitActionData = ImBackSubmitActionData;
	exports.Image = Image;
	exports.ImageRun = ImageRun;
	exports.ImageSet = ImageSet;
	exports.InsertImageAction = InsertImageAction;
	exports.InvokeSubmitActionData = InvokeSubmitActionData;
	exports.LineChart = LineChart;
	exports.LineChartData = LineChartData;
	exports.LineChartValue = LineChartValue;
	exports.Media = Media;
	exports.MediaSource = MediaSource;
	exports.Mention = Mention;
	exports.MentionedEntity = MentionedEntity;
	exports.MessageBackSubmitActionData = MessageBackSubmitActionData;
	exports.NumberInput = NumberInput;
	exports.OpenUrlAction = OpenUrlAction;
	exports.OpenUrlDialogAction = OpenUrlDialogAction;
	exports.PersonaProperties = PersonaProperties;
	exports.PersonaSetProperties = PersonaSetProperties;
	exports.PieChart = PieChart;
	exports.PopoverAction = PopoverAction;
	exports.ProgressBar = ProgressBar;
	exports.ProgressRing = ProgressRing;
	exports.QueryData = QueryData;
	exports.Rating = Rating;
	exports.RatingInput = RatingInput;
	exports.RefreshDefinition = RefreshDefinition;
	exports.ResetInputsAction = ResetInputsAction;
	exports.ResourceProperties = ResourceProperties;
	exports.ResourceVisualization = ResourceVisualization;
	exports.Resources = Resources;
	exports.RichTextBlock = RichTextBlock;
	exports.ShowCardAction = ShowCardAction;
	exports.SigninSubmitActionData = SigninSubmitActionData;
	exports.StackLayout = StackLayout;
	exports.StackedHorizontalBarChart = StackedHorizontalBarChart;
	exports.StackedHorizontalBarChartData = StackedHorizontalBarChartData;
	exports.StackedHorizontalBarChartDataPoint = StackedHorizontalBarChartDataPoint;
	exports.StringResource = StringResource;
	exports.SubmitAction = SubmitAction;
	exports.SubmitActionData = SubmitActionData;
	exports.TabInfo = TabInfo;
	exports.Table = Table;
	exports.TableCell = TableCell;
	exports.TableRow = TableRow;
	exports.TargetElement = TargetElement;
	exports.TaskFetchSubmitActionData = TaskFetchSubmitActionData;
	exports.TeamsCardProperties = TeamsCardProperties;
	exports.TeamsImageProperties = TeamsImageProperties;
	exports.TeamsSubmitActionFeedback = TeamsSubmitActionFeedback;
	exports.TeamsSubmitActionProperties = TeamsSubmitActionProperties;
	exports.TextBlock = TextBlock;
	exports.TextInput = TextInput;
	exports.TextRun = TextRun;
	exports.ThemedUrl = ThemedUrl;
	exports.TimeInput = TimeInput;
	exports.ToggleInput = ToggleInput;
	exports.ToggleVisibilityAction = ToggleVisibilityAction;
	exports.TokenExchangeResource = TokenExchangeResource;
	exports.VerticalBarChart = VerticalBarChart;
	exports.VerticalBarChartDataValue = VerticalBarChartDataValue;
	exports.isActionSet = isActionSet;
	exports.isAdaptiveCard = isAdaptiveCard;
	exports.isAreaGridLayout = isAreaGridLayout;
	exports.isBadge = isBadge;
	exports.isCarousel = isCarousel;
	exports.isCarouselPage = isCarouselPage;
	exports.isChoiceSetInput = isChoiceSetInput;
	exports.isCodeBlock = isCodeBlock;
	exports.isCollabStageInvokeDataValue = isCollabStageInvokeDataValue;
	exports.isColumn = isColumn;
	exports.isColumnSet = isColumnSet;
	exports.isComEventMicrosoftGraphComponent = isComEventMicrosoftGraphComponent;
	exports.isComFileMicrosoftGraphComponent = isComFileMicrosoftGraphComponent;
	exports.isComResourceMicrosoftGraphComponent = isComResourceMicrosoftGraphComponent;
	exports.isComUserMicrosoftGraphComponent = isComUserMicrosoftGraphComponent;
	exports.isComUsersMicrosoftGraphComponent = isComUsersMicrosoftGraphComponent;
	exports.isCompoundButton = isCompoundButton;
	exports.isContainer = isContainer;
	exports.isDateInput = isDateInput;
	exports.isDonutChart = isDonutChart;
	exports.isExecuteAction = isExecuteAction;
	exports.isFactSet = isFactSet;
	exports.isFlowLayout = isFlowLayout;
	exports.isGaugeChart = isGaugeChart;
	exports.isGroupedVerticalBarChart = isGroupedVerticalBarChart;
	exports.isHorizontalBarChart = isHorizontalBarChart;
	exports.isIcon = isIcon;
	exports.isIconRun = isIconRun;
	exports.isImBackSubmitActionData = isImBackSubmitActionData;
	exports.isImage = isImage;
	exports.isImageRun = isImageRun;
	exports.isImageSet = isImageSet;
	exports.isInsertImageAction = isInsertImageAction;
	exports.isInvokeSubmitActionData = isInvokeSubmitActionData;
	exports.isLineChart = isLineChart;
	exports.isMedia = isMedia;
	exports.isMention = isMention;
	exports.isMessageBackSubmitActionData = isMessageBackSubmitActionData;
	exports.isNumberInput = isNumberInput;
	exports.isOpenUrlAction = isOpenUrlAction;
	exports.isOpenUrlDialogAction = isOpenUrlDialogAction;
	exports.isPieChart = isPieChart;
	exports.isPopoverAction = isPopoverAction;
	exports.isProgressBar = isProgressBar;
	exports.isProgressRing = isProgressRing;
	exports.isQueryData = isQueryData;
	exports.isRating = isRating;
	exports.isRatingInput = isRatingInput;
	exports.isResetInputsAction = isResetInputsAction;
	exports.isRichTextBlock = isRichTextBlock;
	exports.isShowCardAction = isShowCardAction;
	exports.isSigninSubmitActionData = isSigninSubmitActionData;
	exports.isStackLayout = isStackLayout;
	exports.isStackedHorizontalBarChart = isStackedHorizontalBarChart;
	exports.isSubmitAction = isSubmitAction;
	exports.isTable = isTable;
	exports.isTableCell = isTableCell;
	exports.isTableRow = isTableRow;
	exports.isTaskFetchSubmitActionData = isTaskFetchSubmitActionData;
	exports.isTextBlock = isTextBlock;
	exports.isTextInput = isTextInput;
	exports.isTextRun = isTextRun;
	exports.isTimeInput = isTimeInput;
	exports.isToggleInput = isToggleInput;
	exports.isToggleVisibilityAction = isToggleVisibilityAction;
	exports.isVerticalBarChart = isVerticalBarChart;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/im-back.js
var require_im_back = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var IMBackAction = class IMBackAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new IMBackData(value) };
		}
		static from(options) {
			return new IMBackAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var IMBackData = class {
		type;
		/**
		* String that needs to be echoed back in the chat.
		*/
		value;
		constructor(value) {
			this.type = "imBack";
			this.value = value;
		}
	};
	exports.IMBackAction = IMBackAction;
	exports.IMBackData = IMBackData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/invoke.js
var require_invoke$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var InvokeAction = class InvokeAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new InvokeData(value) };
		}
		static from(options) {
			return new InvokeAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var InvokeData = class {
		type;
		/**
		* Set the value to send with the invoke
		*/
		value;
		constructor(value) {
			this.type = "invoke";
			this.value = value;
		}
	};
	exports.InvokeAction = InvokeAction;
	exports.InvokeData = InvokeData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/message-back.js
var require_message_back = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var MessageBackAction = class MessageBackAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(data, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new MessageBackData(data.text, data.value, data.displayText) };
		}
		static from(options) {
			return new MessageBackAction(options.data.msteams, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
	};
	var MessageBackData = class {
		type;
		/**
		* Sent to your bot when the action is performed.
		*/
		text;
		/**
		* Used by the user in the chat stream when the action is performed.
		* This text isn't sent to your bot.
		*/
		displayText;
		/**
		* Sent to your bot when the action is performed. You can encode context
		* for the action, such as unique identifiers or a `JSON` object.
		*/
		value;
		constructor(text, value, displayText) {
			this.type = "messageBack";
			this.text = text;
			this.value = value;
			this.displayText = displayText;
		}
		withDisplayText(value) {
			this.displayText = value;
			return this;
		}
	};
	exports.MessageBackAction = MessageBackAction;
	exports.MessageBackData = MessageBackData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/sign-in.js
var require_sign_in$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var SignInAction = class SignInAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new SignInData(value) };
		}
		static from(options) {
			return new SignInAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var SignInData = class {
		type;
		/**
		* Set to the `URL` where you want to redirect.
		*/
		value;
		constructor(value) {
			this.type = "signin";
			this.value = value;
		}
	};
	exports.SignInAction = SignInAction;
	exports.SignInData = SignInData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/task-fetch.js
var require_task_fetch$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var TaskFetchAction = class TaskFetchAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = {
				...value,
				msteams: { type: "task/fetch" }
			};
		}
		static from(options) {
			return new TaskFetchAction(options.data, options);
		}
		withData(value) {
			this.data = value;
			return this;
		}
		withValue(value) {
			super.withData({
				...this.data,
				...value,
				msteams: { type: "task/fetch" }
			});
			return this;
		}
	};
	var TaskFetchData = class {
		msteams = { type: "task/fetch" };
		constructor(data) {
			if (data) {
				const { msteams, ...rest } = data;
				Object.assign(this, rest);
			}
		}
	};
	exports.TaskFetchAction = TaskFetchAction;
	exports.TaskFetchData = TaskFetchData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/collab-stage.js
var require_collab_stage = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	exports.CollabStageAction = class CollabStageAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially 'hidden' properties.
		*/
		data;
		constructor(tab, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = new core.SubmitActionData({ msteams: new core.InvokeSubmitActionData(tab ? new core.CollabStageInvokeDataValue({ tabInfo: tab }) : void 0) });
		}
		static from(options) {
			const value = options.data.msteams?.value;
			return new CollabStageAction(value?.tabInfo, options);
		}
		withData(value) {
			super.withData(new core.SubmitActionData({ msteams: value }));
			return this;
		}
		withValue(value) {
			const msteams = this.data.msteams;
			if (msteams) msteams.value = new core.CollabStageInvokeDataValue({ tabInfo: value });
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/index.js
var require_submit = /* @__PURE__ */ __commonJSMin(((exports) => {
	var imBack = require_im_back();
	var invoke = require_invoke$1();
	var messageBack = require_message_back();
	var signIn = require_sign_in$1();
	var taskFetch = require_task_fetch$1();
	var collabStage = require_collab_stage();
	Object.keys(imBack).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return imBack[k];
			}
		});
	});
	Object.keys(invoke).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invoke[k];
			}
		});
	});
	Object.keys(messageBack).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageBack[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(taskFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskFetch[k];
			}
		});
	});
	Object.keys(collabStage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return collabStage[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/index.js
var require_actions = /* @__PURE__ */ __commonJSMin(((exports) => {
	var submit = require_submit();
	Object.keys(submit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/submit-data.js
var require_submit_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	const RESERVED_KEYWORD = "action";
	var SubmitData = class extends core.SubmitActionData {
		constructor(action, extraData) {
			super();
			if (extraData) Object.assign(this, extraData);
			this[RESERVED_KEYWORD] = action;
		}
	};
	exports.SubmitData = SubmitData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/open-dialog-data.js
var require_open_dialog_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	const RESERVED_KEYWORD = "dialog_id";
	var OpenDialogData = class extends core.SubmitActionData {
		constructor(dialogId, extraData) {
			super({ msteams: new core.TaskFetchSubmitActionData() });
			if (extraData) Object.assign(this, extraData);
			this[RESERVED_KEYWORD] = dialogId;
		}
	};
	exports.OpenDialogData = OpenDialogData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/index.js
var require_utilities = /* @__PURE__ */ __commonJSMin(((exports) => {
	var submitData = require_submit_data();
	var openDialogData = require_open_dialog_data();
	Object.keys(submitData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitData[k];
			}
		});
	});
	Object.keys(openDialogData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return openDialogData[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/index.js
var require_dist$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var actions = require_actions();
	var utilities = require_utilities();
	Object.keys(core).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return core[k];
			}
		});
	});
	Object.keys(actions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return actions[k];
			}
		});
	});
	Object.keys(utilities).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return utilities[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/to-activity-params.js
var require_to_activity_params = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_cards = require_dist$1();
	var message = require_message$1();
	function toActivityParams(activity) {
		if (typeof activity === "string") activity = {
			type: "message",
			text: activity
		};
		else if (teams_cards.isAdaptiveCard(activity)) activity = new message.MessageActivity().addCard("adaptive", activity);
		return activity;
	}
	exports.toActivityParams = toActivityParams;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/index.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stripMentionsText = require_strip_mentions_text();
	var toActivityParams = require_to_activity_params();
	Object.keys(stripMentionsText).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return stripMentionsText[k];
			}
		});
	});
	Object.keys(toActivityParams).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return toActivityParams[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message.js
var require_message$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var models = require_models();
	var activity = require_activity();
	var utils = require_utils();
	exports.MessageActivity = class MessageActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		/**
		* The text to speak.
		* @deprecated This will be removed by end of summer 2026.
		*/
		speak;
		/**
		* Indicates whether your bot is accepting,
		* expecting, or ignoring user input after the message is delivered to the client. Possible
		* values include: 'acceptingInput', 'ignoringInput', 'expectingInput'
		* @deprecated This will be removed by end of summer 2026.
		*/
		inputHint;
		/**
		* The text to display if the channel cannot render cards.
		*/
		summary;
		/**
		* Format of text fields Default:markdown. Possible values include: 'markdown', 'plain', 'xml'
		*/
		textFormat;
		/**
		* The layout hint for multiple attachments. Default: list. Possible values include: 'list',
		* 'carousel'
		*/
		attachmentLayout;
		/**
		* Attachments
		*/
		attachments;
		/**
		* The suggested actions for the activity.
		*/
		suggestedActions;
		/**
		* The importance of the activity. Possible values include: 'low', 'normal', 'high'
		* @deprecated This will be removed by end of summer 2026.
		*/
		importance;
		/**
		* A delivery hint to signal to the recipient alternate delivery paths for the activity.
		* The default delivery mode is "default". Possible values include: 'normal', 'notification'
		*/
		deliveryMode;
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		* @deprecated This will be removed by end of summer 2026.
		*/
		expiration;
		/**
		* A value that is associated with the activity.
		*/
		value;
		constructor(text = "", value = {}) {
			super({
				...value,
				type: "message"
			});
			Object.assign(this, {
				text,
				...value
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageActivity(activity.text, activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({
				stripMentionsText: this.stripMentionsText.bind(this),
				isRecipientMentioned: this.isRecipientMentioned.bind(this),
				getAccountMention: this.getAccountMention.bind(this)
			}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageActivity(this.text, {
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* The text to speak.
		* @deprecated This will be removed by end of summer 2026.
		*/
		withSpeak(value) {
			this.speak = value;
			return this;
		}
		/**
		* Indicates whether your bot is accepting,
		* expecting, or ignoring user input after the message is delivered to the client. Possible
		* values include: 'acceptingInput', 'ignoringInput', 'expectingInput'
		* @deprecated This will be removed by end of summer 2026.
		*/
		withInputHint(value) {
			this.inputHint = value;
			return this;
		}
		/**
		* The text to display if the channel cannot render cards.
		*/
		withSummary(value) {
			this.summary = value;
			return this;
		}
		/**
		* Format of text fields Default:markdown. Possible values include: 'markdown', 'plain', 'xml'
		*/
		withTextFormat(value) {
			this.textFormat = value;
			return this;
		}
		/**
		* The layout hint for multiple attachments. Default: list. Possible values include: 'list',
		* 'carousel'
		*/
		withAttachmentLayout(value) {
			this.attachmentLayout = value;
			return this;
		}
		/**
		* The suggested actions for the activity.
		*/
		withSuggestedActions(value) {
			this.suggestedActions = value;
			return this;
		}
		/**
		* The importance of the activity. Possible values include: 'low', 'normal', 'high'
		* @deprecated This will be removed by end of summer 2026.
		*/
		withImportance(value) {
			this.importance = value;
			return this;
		}
		/**
		* A delivery hint to signal to the recipient alternate delivery paths for the activity.
		* The default delivery mode is "default". Possible values include: 'normal', 'notification'
		*/
		withDeliveryMode(value) {
			this.deliveryMode = value;
			return this;
		}
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		* @deprecated This will be removed by end of summer 2026.
		*/
		withExpiration(value) {
			this.expiration = value;
			return this;
		}
		/**
		* Append text
		*/
		addText(text) {
			this.text += text;
			return this;
		}
		/**
		* Attachments
		*/
		addAttachments(...value) {
			if (!this.attachments) this.attachments = [];
			this.attachments.push(...value);
			return this;
		}
		/**
		* `@mention` an account
		* @param account the account to mention
		* @param options options to customize the mention
		*/
		addMention(account, options = {}) {
			const text = options.text || account.name;
			if (options.addText ?? true) this.addText(`<at>${text}</at>`);
			return this.addEntity({
				type: "mention",
				mentioned: account,
				text: `<at>${text}</at>`
			});
		}
		/**
		* Add a card attachment
		*/
		addCard(type, content) {
			return this.addAttachments(models.cardAttachment(type, content));
		}
		/**
		* remove "\<at>...\</at>" text from an activity
		*/
		stripMentionsText(options = {}) {
			this.text = utils.stripMentionsText(this, options);
			return this;
		}
		/**
		* is the recipient account mentioned
		*/
		isRecipientMentioned() {
			return (this.entities || []).filter((e) => e.type === "mention").some((e) => e.mentioned.id === this.recipient.id);
		}
		/**
		* get a mention by the account id if exists
		*/
		getAccountMention(accountId) {
			return (this.entities || []).filter((e) => e.type === "mention").find((e) => e.mentioned.id === accountId);
		}
		/**
		* Add stream info, making
		* this a final stream message
		*/
		addStreamFinal() {
			if (!this.channelData) this.channelData = {};
			this.channelData.streamId = this.id;
			this.channelData.streamType = "final";
			return this.addEntity({
				type: "streaminfo",
				streamId: this.id,
				streamType: "final"
			});
		}
		/**
		* Set the recipient of this message, optionally marking it as a targeted (ephemeral) message.
		* Targeted messages are only visible to the specified recipient in a shared conversation.
		* @param account - The recipient account
		* @param isTargeted - If true, marks this as a targeted message visible only to the recipient
		* @returns this instance for chaining
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsTargeted
		*/
		withRecipient(account, isTargeted = false) {
			super.withRecipient(account, isTargeted);
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-update.js
var require_message_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageUpdateActivity = class MessageUpdateActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		/**
		* The text to speak.
		* @deprecated This will be removed by end of summer 2026.
		*/
		speak;
		/**
		* The text to display if the channel cannot render cards.
		*/
		summary;
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		* @deprecated This will be removed by end of summer 2026.
		*/
		expiration;
		/**
		* A value that is associated with the activity.
		*/
		value;
		constructor(eventType, value = {}) {
			super({
				...value,
				type: "messageUpdate",
				channelData: {
					...value?.channelData,
					eventType
				}
			});
			Object.assign(this, {
				...value,
				channelData: {
					...value?.channelData,
					eventType
				}
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageUpdateActivity(activity.channelData.eventType, activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageUpdateActivity(this.channelData.eventType, {
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* The text to speak.
		* @deprecated This will be removed by end of summer 2026.
		*/
		withSpeak(value) {
			this.speak = value;
			return this;
		}
		/**
		* The text to display if the channel cannot render cards.
		*/
		withSummary(value) {
			this.summary = value;
			return this;
		}
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		* @deprecated This will be removed by end of summer 2026.
		*/
		withExpiration(value) {
			this.expiration = value;
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-reaction.js
var require_message_reaction = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageReactionActivity = class MessageReactionActivity extends activity.Activity {
		/**
		* The collection of reactions added to the conversation.
		*/
		reactionsAdded;
		/**
		* The collection of reactions removed from the conversation.
		*/
		reactionsRemoved;
		constructor(value = {}) {
			super({
				...value,
				type: "messageReaction"
			});
			Object.assign(this, value);
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageReactionActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageReactionActivity({
				...this.toInterface(),
				...options
			});
		}
		/**
		* Add a message reaction.
		* @deprecated Use the api.reactions.add instead.
		*/
		addReaction(reaction) {
			if (!this.reactionsAdded) this.reactionsAdded = [];
			this.reactionsAdded.push(reaction);
			return this;
		}
		/**
		* Remove a message reaction.
		* @deprecated Use the api.reactions.delete instead.
		*/
		removeReaction(reaction) {
			if (!this.reactionsRemoved) this.reactionsRemoved = [];
			if (this.reactionsAdded) {
				const i = this.reactionsAdded.findIndex((r) => r.type === reaction.type && r.user?.id === reaction.user?.id);
				if (i > -1) this.reactionsAdded.splice(i, 1);
			}
			this.reactionsRemoved.push(reaction);
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/index.js
var require_message$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var messageDelete = require_message_delete();
	var message = require_message$2();
	var messageUpdate = require_message_update();
	var messageReaction = require_message_reaction();
	Object.keys(messageDelete).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageDelete[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(messageUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageUpdate[k];
			}
		});
	});
	Object.keys(messageReaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageReaction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-end.js
var require_meeting_end = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-participant-join.js
var require_meeting_participant_join = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-participant-leave.js
var require_meeting_participant_leave = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-start.js
var require_meeting_start = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/read-receipt.js
var require_read_receipt = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/index.js
var require_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	var meetingEnd = require_meeting_end();
	var meetingParticipantJoin = require_meeting_participant_join();
	var meetingParticipantLeave = require_meeting_participant_leave();
	var meetingStart = require_meeting_start();
	var readReceipt = require_read_receipt();
	Object.keys(meetingEnd).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingEnd[k];
			}
		});
	});
	Object.keys(meetingParticipantJoin).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipantJoin[k];
			}
		});
	});
	Object.keys(meetingParticipantLeave).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipantLeave[k];
			}
		});
	});
	Object.keys(meetingStart).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingStart[k];
			}
		});
	});
	Object.keys(readReceipt).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return readReceipt[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/file-consent.js
var require_file_consent = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/execute-action.js
var require_execute_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/anon-query-link.js
var require_anon_query_link = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/card-button-clicked.js
var require_card_button_clicked = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/fetch-task.js
var require_fetch_task$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query.js
var require_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query-link.js
var require_query_link = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query-setting-url.js
var require_query_setting_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/select-item.js
var require_select_item = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/setting.js
var require_setting = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/submit-action.js
var require_submit_action$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/index.js
var require_message_extension = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anonQueryLink = require_anon_query_link();
	var cardButtonClicked = require_card_button_clicked();
	var fetchTask = require_fetch_task$1();
	var query = require_query();
	var queryLink = require_query_link();
	var querySettingUrl = require_query_setting_url();
	var selectItem = require_select_item();
	var setting = require_setting();
	var submitAction = require_submit_action$1();
	Object.keys(anonQueryLink).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return anonQueryLink[k];
			}
		});
	});
	Object.keys(cardButtonClicked).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardButtonClicked[k];
			}
		});
	});
	Object.keys(fetchTask).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fetchTask[k];
			}
		});
	});
	Object.keys(query).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return query[k];
			}
		});
	});
	Object.keys(queryLink).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return queryLink[k];
			}
		});
	});
	Object.keys(querySettingUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return querySettingUrl[k];
			}
		});
	});
	Object.keys(selectItem).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return selectItem[k];
			}
		});
	});
	Object.keys(setting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return setting[k];
			}
		});
	});
	Object.keys(submitAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/config-fetch.js
var require_config_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/config-submit.js
var require_config_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/index.js
var require_config = /* @__PURE__ */ __commonJSMin(((exports) => {
	var configFetch = require_config_fetch();
	var configSubmit = require_config_submit();
	Object.keys(configFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configFetch[k];
			}
		});
	});
	Object.keys(configSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/tab-fetch.js
var require_tab_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/tab-submit.js
var require_tab_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/index.js
var require_tab = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tabFetch = require_tab_fetch();
	var tabSubmit = require_tab_submit();
	Object.keys(tabFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabFetch[k];
			}
		});
	});
	Object.keys(tabSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/task-fetch.js
var require_task_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/task-submit.js
var require_task_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/index.js
var require_task = /* @__PURE__ */ __commonJSMin(((exports) => {
	var taskFetch = require_task_fetch();
	var taskSubmit = require_task_submit();
	Object.keys(taskFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskFetch[k];
			}
		});
	});
	Object.keys(taskSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/fetch-task.js
var require_fetch_task = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/submit-action.js
var require_submit_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/index.js
var require_message = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fetchTask = require_fetch_task();
	var submitAction = require_submit_action();
	Object.keys(fetchTask).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fetchTask[k];
			}
		});
	});
	Object.keys(submitAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/handoff-action.js
var require_handoff_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/failure.js
var require_failure = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/token-exchange.js
var require_token_exchange = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/verify-state.js
var require_verify_state = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/index.js
var require_sign_in = /* @__PURE__ */ __commonJSMin(((exports) => {
	var failure = require_failure();
	var tokenExchange = require_token_exchange();
	var verifyState = require_verify_state();
	Object.keys(failure).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return failure[k];
			}
		});
	});
	Object.keys(tokenExchange).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchange[k];
			}
		});
	});
	Object.keys(verifyState).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return verifyState[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/adaptive-card/action.js
var require_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/adaptive-card/index.js
var require_adaptive_card = /* @__PURE__ */ __commonJSMin(((exports) => {
	var action = require_action();
	Object.keys(action).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return action[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/index.js
var require_invoke = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fileConsent = require_file_consent();
	var executeAction = require_execute_action();
	var messageExtension = require_message_extension();
	var config = require_config();
	var tab = require_tab();
	var task = require_task();
	var message = require_message();
	var handoffAction = require_handoff_action();
	var signIn = require_sign_in();
	var adaptiveCard = require_adaptive_card();
	Object.keys(fileConsent).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileConsent[k];
			}
		});
	});
	Object.keys(executeAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return executeAction[k];
			}
		});
	});
	Object.keys(messageExtension).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageExtension[k];
			}
		});
	});
	Object.keys(config).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return config[k];
			}
		});
	});
	Object.keys(tab).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tab[k];
			}
		});
	});
	Object.keys(task).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return task[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(handoffAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return handoffAction[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(adaptiveCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCard[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/trace.js
var require_trace = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/typing.js
var require_typing = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.TypingActivity = class TypingActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		constructor(value = {}) {
			super({
				type: "typing",
				...value
			});
			Object.assign(this, value);
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new TypingActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new TypingActivity({
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* Append text
		*/
		addText(text) {
			if (!this.text) this.text = "";
			this.text += text;
			return this;
		}
		/**
		* Add stream informative update
		* @param id the stream id
		* @param sequence the sequence number (index) of the chunk
		*/
		addStreamUpdate(sequence = 0) {
			if (!this.channelData) this.channelData = {};
			if (!this.channelData.streamId) this.channelData.streamId = this.id;
			if (!this.channelData.streamType) this.channelData.streamType = "streaming";
			if (!this.channelData.streamSequence) this.channelData.streamSequence = sequence;
			return this.addEntity({
				type: "streaminfo",
				streamId: this.id,
				streamType: this.channelData.streamType,
				streamSequence: this.channelData.streamSequence
			});
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/handoff.js
var require_handoff = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/conversation-update.js
var require_conversation_update = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/end-of-conversation.js
var require_end_of_conversation = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/index.js
var require_conversation = /* @__PURE__ */ __commonJSMin(((exports) => {
	var conversationUpdate = require_conversation_update();
	var endOfConversation = require_end_of_conversation();
	Object.keys(conversationUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationUpdate[k];
			}
		});
	});
	Object.keys(endOfConversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return endOfConversation[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/command-result.js
var require_command_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/command-send.js
var require_command_send = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/index.js
var require_command = /* @__PURE__ */ __commonJSMin(((exports) => {
	var commandResult = require_command_result();
	var commandSend = require_command_send();
	Object.keys(commandResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return commandResult[k];
			}
		});
	});
	Object.keys(commandSend).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return commandSend[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/add.js
var require_add = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/remove.js
var require_remove = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/index.js
var require_install_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	var add = require_add();
	var remove = require_remove();
	Object.keys(add).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return add[k];
			}
		});
	});
	Object.keys(remove).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return remove[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/index.js
var require_activities = /* @__PURE__ */ __commonJSMin(((exports) => {
	var message = require_message$1();
	var event = require_event();
	var invoke = require_invoke();
	var trace = require_trace();
	var typing = require_typing();
	var handoff = require_handoff();
	var conversation = require_conversation();
	var command = require_command();
	var installUpdate = require_install_update();
	var utils = require_utils();
	var activity = require_activity();
	Object.defineProperty(exports, "$Activity", {
		enumerable: true,
		get: function() {
			return activity.Activity;
		}
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(event).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return event[k];
			}
		});
	});
	Object.keys(invoke).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invoke[k];
			}
		});
	});
	Object.keys(trace).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return trace[k];
			}
		});
	});
	Object.keys(typing).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return typing[k];
			}
		});
	});
	Object.keys(handoff).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return handoff[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(command).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return command[k];
			}
		});
	});
	Object.keys(installUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return installUpdate[k];
			}
		});
	});
	Object.keys(utils).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return utils[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/token.js
var require_token = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/jwt-decode/build/cjs/index.js
var require_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.jwtDecode = exports.InvalidTokenError = void 0;
	var InvalidTokenError = class extends Error {};
	exports.InvalidTokenError = InvalidTokenError;
	InvalidTokenError.prototype.name = "InvalidTokenError";
	function b64DecodeUnicode(str) {
		return decodeURIComponent(atob(str).replace(/(.)/g, (m, p) => {
			let code = p.charCodeAt(0).toString(16).toUpperCase();
			if (code.length < 2) code = "0" + code;
			return "%" + code;
		}));
	}
	function base64UrlDecode(str) {
		let output = str.replace(/-/g, "+").replace(/_/g, "/");
		switch (output.length % 4) {
			case 0: break;
			case 2:
				output += "==";
				break;
			case 3:
				output += "=";
				break;
			default: throw new Error("base64 string is not of the correct length");
		}
		try {
			return b64DecodeUnicode(output);
		} catch (err) {
			return atob(output);
		}
	}
	function jwtDecode(token, options) {
		if (typeof token !== "string") throw new InvalidTokenError("Invalid token specified: must be a string");
		options || (options = {});
		const pos = options.header === true ? 0 : 1;
		const part = token.split(".")[pos];
		if (typeof part !== "string") throw new InvalidTokenError(`Invalid token specified: missing part #${pos + 1}`);
		let decoded;
		try {
			decoded = base64UrlDecode(part);
		} catch (e) {
			throw new InvalidTokenError(`Invalid token specified: invalid base64 for part #${pos + 1} (${e.message})`);
		}
		try {
			return JSON.parse(decoded);
		} catch (e) {
			throw new InvalidTokenError(`Invalid token specified: invalid json for part #${pos + 1} (${e.message})`);
		}
	}
	exports.jwtDecode = jwtDecode;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/caller.js
var require_caller = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.CallerIds = {
		azure: "urn:botframework:azure",
		gov: "urn:botframework:azureusgov",
		bot: "urn:botframework:aadappid"
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/json-web-token.js
var require_json_web_token = /* @__PURE__ */ __commonJSMin(((exports) => {
	var jwtDecode = require_cjs();
	var caller = require_caller();
	var JsonWebToken = class {
		get audience() {
			return this._payload.aud;
		}
		get issuer() {
			return this._payload.iss;
		}
		get keyId() {
			return this._payload["kid"];
		}
		get appId() {
			return this._payload["appid"];
		}
		get appDisplayName() {
			return this._payload["app_displayname"];
		}
		get tenantId() {
			return this._payload["tid"];
		}
		get version() {
			return this._payload["version"];
		}
		get serviceUrl() {
			let v = this._payload["serviceurl"] || "https://smba.trafficmanager.net/teams";
			if (v.endsWith("/")) v = v.slice(0, v.length - 1);
			return v;
		}
		get from() {
			if (this.appId) return "bot";
			return "azure";
		}
		get fromId() {
			if (this.from === "bot") return `${caller.CallerIds.bot}:${this.appId}`;
			return caller.CallerIds.azure;
		}
		get expiration() {
			if (this._payload.exp) return this._payload.exp * 1e3;
		}
		_value;
		_payload;
		constructor(value) {
			this._value = value;
			this._payload = jwtDecode.jwtDecode(value);
		}
		isExpired(bufferMs = 1e3 * 60 * 5) {
			if (!this.expiration) return false;
			return this.expiration < Date.now() + bufferMs;
		}
		toString() {
			return this._value;
		}
	};
	exports.JsonWebToken = JsonWebToken;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/credentials.js
var require_credentials = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/cloud-environment.js
var require_cloud_environment = /* @__PURE__ */ __commonJSMin(((exports) => {
	const PUBLIC = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.com",
		loginTenant: "botframework.com",
		botScope: "https://api.botframework.com/.default",
		tokenServiceUrl: "https://token.botframework.com",
		openIdMetadataUrl: "https://login.botframework.com/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.com",
		graphScope: "https://graph.microsoft.com/.default"
	});
	const US_GOV = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.us",
		loginTenant: "MicrosoftServices.onmicrosoft.us",
		botScope: "https://api.botframework.us/.default",
		tokenServiceUrl: "https://tokengcch.botframework.azure.us",
		openIdMetadataUrl: "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.us",
		graphScope: "https://graph.microsoft.us/.default"
	});
	const US_GOV_DOD = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.us",
		loginTenant: "MicrosoftServices.onmicrosoft.us",
		botScope: "https://api.botframework.us/.default",
		tokenServiceUrl: "https://apiDoD.botframework.azure.us",
		openIdMetadataUrl: "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.us",
		graphScope: "https://dod-graph.microsoft.us/.default"
	});
	const CHINA = Object.freeze({
		loginEndpoint: "https://login.partner.microsoftonline.cn",
		loginTenant: "microsoftservices.partner.onmschina.cn",
		botScope: "https://api.botframework.azure.cn/.default",
		tokenServiceUrl: "https://token.botframework.azure.cn",
		openIdMetadataUrl: "https://login.botframework.azure.cn/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.azure.cn",
		graphScope: "https://microsoftgraph.chinacloudapi.cn/.default"
	});
	function withOverrides(base, overrides) {
		return Object.freeze({
			loginEndpoint: overrides.loginEndpoint ?? base.loginEndpoint,
			loginTenant: overrides.loginTenant ?? base.loginTenant,
			botScope: overrides.botScope ?? base.botScope,
			tokenServiceUrl: overrides.tokenServiceUrl ?? base.tokenServiceUrl,
			openIdMetadataUrl: overrides.openIdMetadataUrl ?? base.openIdMetadataUrl,
			tokenIssuer: overrides.tokenIssuer ?? base.tokenIssuer,
			graphScope: overrides.graphScope ?? base.graphScope
		});
	}
	const CLOUD_ENVIRONMENTS = {
		public: PUBLIC,
		usgov: US_GOV,
		usgovdod: US_GOV_DOD,
		china: CHINA
	};
	function cloudFromName(name) {
		const env = CLOUD_ENVIRONMENTS[name.toLowerCase()];
		if (!env) throw new Error(`Unknown cloud environment: '${name}'. Valid values are: Public, USGov, USGovDoD, China.`);
		return env;
	}
	exports.CHINA = CHINA;
	exports.PUBLIC = PUBLIC;
	exports.US_GOV = US_GOV;
	exports.US_GOV_DOD = US_GOV_DOD;
	exports.cloudFromName = cloudFromName;
	exports.withOverrides = withOverrides;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/index.js
var require_auth = /* @__PURE__ */ __commonJSMin(((exports) => {
	var token = require_token();
	var jsonWebToken = require_json_web_token();
	var credentials = require_credentials();
	var cloudEnvironment = require_cloud_environment();
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
	Object.keys(jsonWebToken).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return jsonWebToken[k];
			}
		});
	});
	Object.keys(credentials).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return credentials[k];
			}
		});
	});
	Object.keys(cloudEnvironment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cloudEnvironment[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var clients = require_clients();
	var models = require_models();
	var activities = require_activities();
	var auth = require_auth();
	Object.keys(clients).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return clients[k];
			}
		});
	});
	Object.keys(models).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return models[k];
			}
		});
	});
	Object.keys(activities).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activities[k];
			}
		});
	});
	Object.keys(auth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return auth[k];
			}
		});
	});
}));
//#endregion
export { require_axios as i, require_lib as n, require_dist$2 as r, require_dist as t };
