import { n as __esmMin } from "./chunk-CNf5ZN-e.js";
import { c as init_fetch_blob, i as init_esm_min, n as FormData, r as formDataToBlob, s as Blob, t as init_from } from "./from-BmBS_MYA.js";
import { format } from "node:url";
import { isIP } from "node:net";
import Stream, { PassThrough, pipeline } from "node:stream";
import { deprecate, promisify, types } from "node:util";
import { Buffer as Buffer$1 } from "node:buffer";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
//#region node_modules/data-uri-to-buffer/dist/index.js
/**
* Returns a `Buffer` instance from the given data URI `uri`.
*
* @param {String} uri Data URI to turn into a Buffer instance
* @returns {Buffer} Buffer instance from Data URI
* @api public
*/
function dataUriToBuffer(uri) {
	if (!/^data:/i.test(uri)) throw new TypeError("`uri` does not appear to be a Data URI (must begin with \"data:\")");
	uri = uri.replace(/\r?\n/g, "");
	const firstComma = uri.indexOf(",");
	if (firstComma === -1 || firstComma <= 4) throw new TypeError("malformed data: URI");
	const meta = uri.substring(5, firstComma).split(";");
	let charset = "";
	let base64 = false;
	const type = meta[0] || "text/plain";
	let typeFull = type;
	for (let i = 1; i < meta.length; i++) if (meta[i] === "base64") base64 = true;
	else if (meta[i]) {
		typeFull += `;${meta[i]}`;
		if (meta[i].indexOf("charset=") === 0) charset = meta[i].substring(8);
	}
	if (!meta[0] && !charset.length) {
		typeFull += ";charset=US-ASCII";
		charset = "US-ASCII";
	}
	const encoding = base64 ? "base64" : "ascii";
	const data = unescape(uri.substring(firstComma + 1));
	const buffer = Buffer.from(data, encoding);
	buffer.type = type;
	buffer.typeFull = typeFull;
	buffer.charset = charset;
	return buffer;
}
var init_dist = __esmMin((() => {}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/errors/base.js
var FetchBaseError;
var init_base = __esmMin((() => {
	FetchBaseError = class extends Error {
		constructor(message, type) {
			super(message);
			Error.captureStackTrace(this, this.constructor);
			this.type = type;
		}
		get name() {
			return this.constructor.name;
		}
		get [Symbol.toStringTag]() {
			return this.constructor.name;
		}
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/errors/fetch-error.js
var FetchError;
var init_fetch_error = __esmMin((() => {
	init_base();
	FetchError = class extends FetchBaseError {
		/**
		* @param  {string} message -      Error message for human
		* @param  {string} [type] -        Error type for machine
		* @param  {SystemError} [systemError] - For Node.js system error
		*/
		constructor(message, type, systemError) {
			super(message, type);
			if (systemError) {
				this.code = this.errno = systemError.code;
				this.erroredSysCall = systemError.syscall;
			}
		}
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/utils/is.js
var NAME, isURLSearchParameters, isBlob, isAbortSignal, isDomainOrSubdomain, isSameProtocol;
var init_is = __esmMin((() => {
	NAME = Symbol.toStringTag;
	isURLSearchParameters = (object) => {
		return typeof object === "object" && typeof object.append === "function" && typeof object.delete === "function" && typeof object.get === "function" && typeof object.getAll === "function" && typeof object.has === "function" && typeof object.set === "function" && typeof object.sort === "function" && object[NAME] === "URLSearchParams";
	};
	isBlob = (object) => {
		return object && typeof object === "object" && typeof object.arrayBuffer === "function" && typeof object.type === "string" && typeof object.stream === "function" && typeof object.constructor === "function" && /^(Blob|File)$/.test(object[NAME]);
	};
	isAbortSignal = (object) => {
		return typeof object === "object" && (object[NAME] === "AbortSignal" || object[NAME] === "EventTarget");
	};
	isDomainOrSubdomain = (destination, original) => {
		const orig = new URL(original).hostname;
		const dest = new URL(destination).hostname;
		return orig === dest || orig.endsWith(`.${dest}`);
	};
	isSameProtocol = (destination, original) => {
		return new URL(original).protocol === new URL(destination).protocol;
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/body.js
/**
* Body.js
*
* Body interface provides common methods for Request and Response
*/
/**
* Consume and convert an entire Body to a Buffer.
*
* Ref: https://fetch.spec.whatwg.org/#concept-body-consume-body
*
* @return Promise
*/
async function consumeBody(data) {
	if (data[INTERNALS$2].disturbed) throw new TypeError(`body used already for: ${data.url}`);
	data[INTERNALS$2].disturbed = true;
	if (data[INTERNALS$2].error) throw data[INTERNALS$2].error;
	const { body } = data;
	if (body === null) return Buffer$1.alloc(0);
	/* c8 ignore next 3 */
	if (!(body instanceof Stream)) return Buffer$1.alloc(0);
	const accum = [];
	let accumBytes = 0;
	try {
		for await (const chunk of body) {
			if (data.size > 0 && accumBytes + chunk.length > data.size) {
				const error = new FetchError(`content size at ${data.url} over limit: ${data.size}`, "max-size");
				body.destroy(error);
				throw error;
			}
			accumBytes += chunk.length;
			accum.push(chunk);
		}
	} catch (error) {
		throw error instanceof FetchBaseError ? error : new FetchError(`Invalid response body while trying to fetch ${data.url}: ${error.message}`, "system", error);
	}
	if (body.readableEnded === true || body._readableState.ended === true) try {
		if (accum.every((c) => typeof c === "string")) return Buffer$1.from(accum.join(""));
		return Buffer$1.concat(accum, accumBytes);
	} catch (error) {
		throw new FetchError(`Could not create Buffer from response body for ${data.url}: ${error.message}`, "system", error);
	}
	else throw new FetchError(`Premature close of server response while trying to fetch ${data.url}`);
}
var pipeline$1, INTERNALS$2, Body, clone, getNonSpecFormDataBoundary, extractContentType, getTotalBytes, writeToStream;
var init_body = __esmMin((() => {
	init_fetch_blob();
	init_esm_min();
	init_fetch_error();
	init_base();
	init_is();
	pipeline$1 = promisify(Stream.pipeline);
	INTERNALS$2 = Symbol("Body internals");
	Body = class {
		constructor(body, { size = 0 } = {}) {
			let boundary = null;
			if (body === null) body = null;
			else if (isURLSearchParameters(body)) body = Buffer$1.from(body.toString());
			else if (isBlob(body)) {} else if (Buffer$1.isBuffer(body)) {} else if (types.isAnyArrayBuffer(body)) body = Buffer$1.from(body);
			else if (ArrayBuffer.isView(body)) body = Buffer$1.from(body.buffer, body.byteOffset, body.byteLength);
			else if (body instanceof Stream) {} else if (body instanceof FormData) {
				body = formDataToBlob(body);
				boundary = body.type.split("=")[1];
			} else body = Buffer$1.from(String(body));
			let stream = body;
			if (Buffer$1.isBuffer(body)) stream = Stream.Readable.from(body);
			else if (isBlob(body)) stream = Stream.Readable.from(body.stream());
			this[INTERNALS$2] = {
				body,
				stream,
				boundary,
				disturbed: false,
				error: null
			};
			this.size = size;
			if (body instanceof Stream) body.on("error", (error_) => {
				const error = error_ instanceof FetchBaseError ? error_ : new FetchError(`Invalid response body while trying to fetch ${this.url}: ${error_.message}`, "system", error_);
				this[INTERNALS$2].error = error;
			});
		}
		get body() {
			return this[INTERNALS$2].stream;
		}
		get bodyUsed() {
			return this[INTERNALS$2].disturbed;
		}
		/**
		* Decode response as ArrayBuffer
		*
		* @return  Promise
		*/
		async arrayBuffer() {
			const { buffer, byteOffset, byteLength } = await consumeBody(this);
			return buffer.slice(byteOffset, byteOffset + byteLength);
		}
		async formData() {
			const ct = this.headers.get("content-type");
			if (ct.startsWith("application/x-www-form-urlencoded")) {
				const formData = new FormData();
				const parameters = new URLSearchParams(await this.text());
				for (const [name, value] of parameters) formData.append(name, value);
				return formData;
			}
			const { toFormData } = await import("./multipart-parser-BE-gAMcs.js");
			return toFormData(this.body, ct);
		}
		/**
		* Return raw response as Blob
		*
		* @return Promise
		*/
		async blob() {
			const ct = this.headers && this.headers.get("content-type") || this[INTERNALS$2].body && this[INTERNALS$2].body.type || "";
			return new Blob([await this.arrayBuffer()], { type: ct });
		}
		/**
		* Decode response as json
		*
		* @return  Promise
		*/
		async json() {
			const text = await this.text();
			return JSON.parse(text);
		}
		/**
		* Decode response as text
		*
		* @return  Promise
		*/
		async text() {
			const buffer = await consumeBody(this);
			return new TextDecoder().decode(buffer);
		}
		/**
		* Decode response as buffer (non-spec api)
		*
		* @return  Promise
		*/
		buffer() {
			return consumeBody(this);
		}
	};
	Body.prototype.buffer = deprecate(Body.prototype.buffer, "Please use 'response.arrayBuffer()' instead of 'response.buffer()'", "node-fetch#buffer");
	Object.defineProperties(Body.prototype, {
		body: { enumerable: true },
		bodyUsed: { enumerable: true },
		arrayBuffer: { enumerable: true },
		blob: { enumerable: true },
		json: { enumerable: true },
		text: { enumerable: true },
		data: { get: deprecate(() => {}, "data doesn't exist, use json(), text(), arrayBuffer(), or body instead", "https://github.com/node-fetch/node-fetch/issues/1000 (response)") }
	});
	clone = (instance, highWaterMark) => {
		let p1;
		let p2;
		let { body } = instance[INTERNALS$2];
		if (instance.bodyUsed) throw new Error("cannot clone body after it is used");
		if (body instanceof Stream && typeof body.getBoundary !== "function") {
			p1 = new PassThrough({ highWaterMark });
			p2 = new PassThrough({ highWaterMark });
			body.pipe(p1);
			body.pipe(p2);
			instance[INTERNALS$2].stream = p1;
			body = p2;
		}
		return body;
	};
	getNonSpecFormDataBoundary = deprecate((body) => body.getBoundary(), "form-data doesn't follow the spec and requires special treatment. Use alternative package", "https://github.com/node-fetch/node-fetch/issues/1167");
	extractContentType = (body, request) => {
		if (body === null) return null;
		if (typeof body === "string") return "text/plain;charset=UTF-8";
		if (isURLSearchParameters(body)) return "application/x-www-form-urlencoded;charset=UTF-8";
		if (isBlob(body)) return body.type || null;
		if (Buffer$1.isBuffer(body) || types.isAnyArrayBuffer(body) || ArrayBuffer.isView(body)) return null;
		if (body instanceof FormData) return `multipart/form-data; boundary=${request[INTERNALS$2].boundary}`;
		if (body && typeof body.getBoundary === "function") return `multipart/form-data;boundary=${getNonSpecFormDataBoundary(body)}`;
		if (body instanceof Stream) return null;
		return "text/plain;charset=UTF-8";
	};
	getTotalBytes = (request) => {
		const { body } = request[INTERNALS$2];
		if (body === null) return 0;
		if (isBlob(body)) return body.size;
		if (Buffer$1.isBuffer(body)) return body.length;
		if (body && typeof body.getLengthSync === "function") return body.hasKnownLength && body.hasKnownLength() ? body.getLengthSync() : null;
		return null;
	};
	writeToStream = async (dest, { body }) => {
		if (body === null) dest.end();
		else await pipeline$1(body, dest);
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/headers.js
/**
* Headers.js
*
* Headers class offers convenient helpers
*/
/**
* Create a Headers object from an http.IncomingMessage.rawHeaders, ignoring those that do
* not conform to HTTP grammar productions.
* @param {import('http').IncomingMessage['rawHeaders']} headers
*/
function fromRawHeaders(headers = []) {
	return new Headers(headers.reduce((result, value, index, array) => {
		if (index % 2 === 0) result.push(array.slice(index, index + 2));
		return result;
	}, []).filter(([name, value]) => {
		try {
			validateHeaderName(name);
			validateHeaderValue(name, String(value));
			return true;
		} catch {
			return false;
		}
	}));
}
var validateHeaderName, validateHeaderValue, Headers;
var init_headers = __esmMin((() => {
	validateHeaderName = typeof http.validateHeaderName === "function" ? http.validateHeaderName : (name) => {
		if (!/^[\^`\-\w!#$%&'*+.|~]+$/.test(name)) {
			const error = /* @__PURE__ */ new TypeError(`Header name must be a valid HTTP token [${name}]`);
			Object.defineProperty(error, "code", { value: "ERR_INVALID_HTTP_TOKEN" });
			throw error;
		}
	};
	validateHeaderValue = typeof http.validateHeaderValue === "function" ? http.validateHeaderValue : (name, value) => {
		if (/[^\t\u0020-\u007E\u0080-\u00FF]/.test(value)) {
			const error = /* @__PURE__ */ new TypeError(`Invalid character in header content ["${name}"]`);
			Object.defineProperty(error, "code", { value: "ERR_INVALID_CHAR" });
			throw error;
		}
	};
	Headers = class Headers extends URLSearchParams {
		/**
		* Headers class
		*
		* @constructor
		* @param {HeadersInit} [init] - Response headers
		*/
		constructor(init) {
			/** @type {string[][]} */
			let result = [];
			if (init instanceof Headers) {
				const raw = init.raw();
				for (const [name, values] of Object.entries(raw)) result.push(...values.map((value) => [name, value]));
			} else if (init == null) {} else if (typeof init === "object" && !types.isBoxedPrimitive(init)) {
				const method = init[Symbol.iterator];
				if (method == null) result.push(...Object.entries(init));
				else {
					if (typeof method !== "function") throw new TypeError("Header pairs must be iterable");
					result = [...init].map((pair) => {
						if (typeof pair !== "object" || types.isBoxedPrimitive(pair)) throw new TypeError("Each header pair must be an iterable object");
						return [...pair];
					}).map((pair) => {
						if (pair.length !== 2) throw new TypeError("Each header pair must be a name/value tuple");
						return [...pair];
					});
				}
			} else throw new TypeError("Failed to construct 'Headers': The provided value is not of type '(sequence<sequence<ByteString>> or record<ByteString, ByteString>)");
			result = result.length > 0 ? result.map(([name, value]) => {
				validateHeaderName(name);
				validateHeaderValue(name, String(value));
				return [String(name).toLowerCase(), String(value)];
			}) : void 0;
			super(result);
			return new Proxy(this, { get(target, p, receiver) {
				switch (p) {
					case "append":
					case "set": return (name, value) => {
						validateHeaderName(name);
						validateHeaderValue(name, String(value));
						return URLSearchParams.prototype[p].call(target, String(name).toLowerCase(), String(value));
					};
					case "delete":
					case "has":
					case "getAll": return (name) => {
						validateHeaderName(name);
						return URLSearchParams.prototype[p].call(target, String(name).toLowerCase());
					};
					case "keys": return () => {
						target.sort();
						return new Set(URLSearchParams.prototype.keys.call(target)).keys();
					};
					default: return Reflect.get(target, p, receiver);
				}
			} });
			/* c8 ignore next */
		}
		get [Symbol.toStringTag]() {
			return this.constructor.name;
		}
		toString() {
			return Object.prototype.toString.call(this);
		}
		get(name) {
			const values = this.getAll(name);
			if (values.length === 0) return null;
			let value = values.join(", ");
			if (/^content-encoding$/i.test(name)) value = value.toLowerCase();
			return value;
		}
		forEach(callback, thisArg = void 0) {
			for (const name of this.keys()) Reflect.apply(callback, thisArg, [
				this.get(name),
				name,
				this
			]);
		}
		*values() {
			for (const name of this.keys()) yield this.get(name);
		}
		/**
		* @type {() => IterableIterator<[string, string]>}
		*/
		*entries() {
			for (const name of this.keys()) yield [name, this.get(name)];
		}
		[Symbol.iterator]() {
			return this.entries();
		}
		/**
		* Node-fetch non-spec method
		* returning all headers and their values as array
		* @returns {Record<string, string[]>}
		*/
		raw() {
			return [...this.keys()].reduce((result, key) => {
				result[key] = this.getAll(key);
				return result;
			}, {});
		}
		/**
		* For better console.log(headers) and also to convert Headers into Node.js Request compatible format
		*/
		[Symbol.for("nodejs.util.inspect.custom")]() {
			return [...this.keys()].reduce((result, key) => {
				const values = this.getAll(key);
				if (key === "host") result[key] = values[0];
				else result[key] = values.length > 1 ? values : values[0];
				return result;
			}, {});
		}
	};
	/**
	* Re-shaping object for Web IDL tests
	* Only need to do it for overridden methods
	*/
	Object.defineProperties(Headers.prototype, [
		"get",
		"entries",
		"forEach",
		"values"
	].reduce((result, property) => {
		result[property] = { enumerable: true };
		return result;
	}, {}));
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/utils/is-redirect.js
var redirectStatus, isRedirect;
var init_is_redirect = __esmMin((() => {
	redirectStatus = new Set([
		301,
		302,
		303,
		307,
		308
	]);
	isRedirect = (code) => {
		return redirectStatus.has(code);
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/response.js
var INTERNALS$1, Response;
var init_response = __esmMin((() => {
	init_headers();
	init_body();
	init_is_redirect();
	INTERNALS$1 = Symbol("Response internals");
	Response = class Response extends Body {
		constructor(body = null, options = {}) {
			super(body, options);
			const status = options.status != null ? options.status : 200;
			const headers = new Headers(options.headers);
			if (body !== null && !headers.has("Content-Type")) {
				const contentType = extractContentType(body, this);
				if (contentType) headers.append("Content-Type", contentType);
			}
			this[INTERNALS$1] = {
				type: "default",
				url: options.url,
				status,
				statusText: options.statusText || "",
				headers,
				counter: options.counter,
				highWaterMark: options.highWaterMark
			};
		}
		get type() {
			return this[INTERNALS$1].type;
		}
		get url() {
			return this[INTERNALS$1].url || "";
		}
		get status() {
			return this[INTERNALS$1].status;
		}
		/**
		* Convenience property representing if the request ended normally
		*/
		get ok() {
			return this[INTERNALS$1].status >= 200 && this[INTERNALS$1].status < 300;
		}
		get redirected() {
			return this[INTERNALS$1].counter > 0;
		}
		get statusText() {
			return this[INTERNALS$1].statusText;
		}
		get headers() {
			return this[INTERNALS$1].headers;
		}
		get highWaterMark() {
			return this[INTERNALS$1].highWaterMark;
		}
		/**
		* Clone this response
		*
		* @return  Response
		*/
		clone() {
			return new Response(clone(this, this.highWaterMark), {
				type: this.type,
				url: this.url,
				status: this.status,
				statusText: this.statusText,
				headers: this.headers,
				ok: this.ok,
				redirected: this.redirected,
				size: this.size,
				highWaterMark: this.highWaterMark
			});
		}
		/**
		* @param {string} url    The URL that the new response is to originate from.
		* @param {number} status An optional status code for the response (e.g., 302.)
		* @returns {Response}    A Response object.
		*/
		static redirect(url, status = 302) {
			if (!isRedirect(status)) throw new RangeError("Failed to execute \"redirect\" on \"response\": Invalid status code");
			return new Response(null, {
				headers: { location: new URL(url).toString() },
				status
			});
		}
		static error() {
			const response = new Response(null, {
				status: 0,
				statusText: ""
			});
			response[INTERNALS$1].type = "error";
			return response;
		}
		static json(data = void 0, init = {}) {
			const body = JSON.stringify(data);
			if (body === void 0) throw new TypeError("data is not JSON serializable");
			const headers = new Headers(init && init.headers);
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
			return new Response(body, {
				...init,
				headers
			});
		}
		get [Symbol.toStringTag]() {
			return "Response";
		}
	};
	Object.defineProperties(Response.prototype, {
		type: { enumerable: true },
		url: { enumerable: true },
		status: { enumerable: true },
		ok: { enumerable: true },
		redirected: { enumerable: true },
		statusText: { enumerable: true },
		headers: { enumerable: true },
		clone: { enumerable: true }
	});
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/utils/get-search.js
var getSearch;
var init_get_search = __esmMin((() => {
	getSearch = (parsedURL) => {
		if (parsedURL.search) return parsedURL.search;
		const lastOffset = parsedURL.href.length - 1;
		const hash = parsedURL.hash || (parsedURL.href[lastOffset] === "#" ? "#" : "");
		return parsedURL.href[lastOffset - hash.length] === "?" ? "?" : "";
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/utils/referrer.js
/**
* @external URL
* @see {@link https://developer.mozilla.org/en-US/docs/Web/API/URL|URL}
*/
/**
* @module utils/referrer
* @private
*/
/**
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#strip-url|Referrer Policy §8.4. Strip url for use as a referrer}
* @param {string} URL
* @param {boolean} [originOnly=false]
*/
function stripURLForUseAsAReferrer(url, originOnly = false) {
	if (url == null) return "no-referrer";
	url = new URL(url);
	if (/^(about|blob|data):$/.test(url.protocol)) return "no-referrer";
	url.username = "";
	url.password = "";
	url.hash = "";
	if (originOnly) {
		url.pathname = "";
		url.search = "";
	}
	return url;
}
/**
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#referrer-policies|Referrer Policy §3. Referrer Policies}
* @param {string} referrerPolicy
* @returns {string} referrerPolicy
*/
function validateReferrerPolicy(referrerPolicy) {
	if (!ReferrerPolicy.has(referrerPolicy)) throw new TypeError(`Invalid referrerPolicy: ${referrerPolicy}`);
	return referrerPolicy;
}
/**
* @see {@link https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy|Referrer Policy §3.2. Is origin potentially trustworthy?}
* @param {external:URL} url
* @returns `true`: "Potentially Trustworthy", `false`: "Not Trustworthy"
*/
function isOriginPotentiallyTrustworthy(url) {
	if (/^(http|ws)s:$/.test(url.protocol)) return true;
	const hostIp = url.host.replace(/(^\[)|(]$)/g, "");
	const hostIPVersion = isIP(hostIp);
	if (hostIPVersion === 4 && /^127\./.test(hostIp)) return true;
	if (hostIPVersion === 6 && /^(((0+:){7})|(::(0+:){0,6}))0*1$/.test(hostIp)) return true;
	if (url.host === "localhost" || url.host.endsWith(".localhost")) return false;
	if (url.protocol === "file:") return true;
	return false;
}
/**
* @see {@link https://w3c.github.io/webappsec-secure-contexts/#is-url-trustworthy|Referrer Policy §3.3. Is url potentially trustworthy?}
* @param {external:URL} url
* @returns `true`: "Potentially Trustworthy", `false`: "Not Trustworthy"
*/
function isUrlPotentiallyTrustworthy(url) {
	if (/^about:(blank|srcdoc)$/.test(url)) return true;
	if (url.protocol === "data:") return true;
	if (/^(blob|filesystem):$/.test(url.protocol)) return true;
	return isOriginPotentiallyTrustworthy(url);
}
/**
* Modifies the referrerURL to enforce any extra security policy considerations.
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer|Referrer Policy §8.3. Determine request's Referrer}, step 7
* @callback module:utils/referrer~referrerURLCallback
* @param {external:URL} referrerURL
* @returns {external:URL} modified referrerURL
*/
/**
* Modifies the referrerOrigin to enforce any extra security policy considerations.
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer|Referrer Policy §8.3. Determine request's Referrer}, step 7
* @callback module:utils/referrer~referrerOriginCallback
* @param {external:URL} referrerOrigin
* @returns {external:URL} modified referrerOrigin
*/
/**
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#determine-requests-referrer|Referrer Policy §8.3. Determine request's Referrer}
* @param {Request} request
* @param {object} o
* @param {module:utils/referrer~referrerURLCallback} o.referrerURLCallback
* @param {module:utils/referrer~referrerOriginCallback} o.referrerOriginCallback
* @returns {external:URL} Request's referrer
*/
function determineRequestsReferrer(request, { referrerURLCallback, referrerOriginCallback } = {}) {
	if (request.referrer === "no-referrer" || request.referrerPolicy === "") return null;
	const policy = request.referrerPolicy;
	if (request.referrer === "about:client") return "no-referrer";
	const referrerSource = request.referrer;
	let referrerURL = stripURLForUseAsAReferrer(referrerSource);
	let referrerOrigin = stripURLForUseAsAReferrer(referrerSource, true);
	if (referrerURL.toString().length > 4096) referrerURL = referrerOrigin;
	if (referrerURLCallback) referrerURL = referrerURLCallback(referrerURL);
	if (referrerOriginCallback) referrerOrigin = referrerOriginCallback(referrerOrigin);
	const currentURL = new URL(request.url);
	switch (policy) {
		case "no-referrer": return "no-referrer";
		case "origin": return referrerOrigin;
		case "unsafe-url": return referrerURL;
		case "strict-origin":
			if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) return "no-referrer";
			return referrerOrigin.toString();
		case "strict-origin-when-cross-origin":
			if (referrerURL.origin === currentURL.origin) return referrerURL;
			if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) return "no-referrer";
			return referrerOrigin;
		case "same-origin":
			if (referrerURL.origin === currentURL.origin) return referrerURL;
			return "no-referrer";
		case "origin-when-cross-origin":
			if (referrerURL.origin === currentURL.origin) return referrerURL;
			return referrerOrigin;
		case "no-referrer-when-downgrade":
			if (isUrlPotentiallyTrustworthy(referrerURL) && !isUrlPotentiallyTrustworthy(currentURL)) return "no-referrer";
			return referrerURL;
		default: throw new TypeError(`Invalid referrerPolicy: ${policy}`);
	}
}
/**
* @see {@link https://w3c.github.io/webappsec-referrer-policy/#parse-referrer-policy-from-header|Referrer Policy §8.1. Parse a referrer policy from a Referrer-Policy header}
* @param {Headers} headers Response headers
* @returns {string} policy
*/
function parseReferrerPolicyFromHeader(headers) {
	const policyTokens = (headers.get("referrer-policy") || "").split(/[,\s]+/);
	let policy = "";
	for (const token of policyTokens) if (token && ReferrerPolicy.has(token)) policy = token;
	return policy;
}
var ReferrerPolicy, DEFAULT_REFERRER_POLICY;
var init_referrer = __esmMin((() => {
	ReferrerPolicy = new Set([
		"",
		"no-referrer",
		"no-referrer-when-downgrade",
		"same-origin",
		"origin",
		"strict-origin",
		"origin-when-cross-origin",
		"strict-origin-when-cross-origin",
		"unsafe-url"
	]);
	DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/request.js
/**
* Request.js
*
* Request class contains server only options
*
* All spec algorithm step numbers are based on https://fetch.spec.whatwg.org/commit-snapshots/ae716822cb3a61843226cd090eefc6589446c1d2/.
*/
var INTERNALS, isRequest, doBadDataWarn, Request, getNodeRequestOptions;
var init_request = __esmMin((() => {
	init_headers();
	init_body();
	init_is();
	init_get_search();
	init_referrer();
	INTERNALS = Symbol("Request internals");
	isRequest = (object) => {
		return typeof object === "object" && typeof object[INTERNALS] === "object";
	};
	doBadDataWarn = deprecate(() => {}, ".data is not a valid RequestInit property, use .body instead", "https://github.com/node-fetch/node-fetch/issues/1000 (request)");
	Request = class Request extends Body {
		constructor(input, init = {}) {
			let parsedURL;
			if (isRequest(input)) parsedURL = new URL(input.url);
			else {
				parsedURL = new URL(input);
				input = {};
			}
			if (parsedURL.username !== "" || parsedURL.password !== "") throw new TypeError(`${parsedURL} is an url with embedded credentials.`);
			let method = init.method || input.method || "GET";
			if (/^(delete|get|head|options|post|put)$/i.test(method)) method = method.toUpperCase();
			if (!isRequest(init) && "data" in init) doBadDataWarn();
			if ((init.body != null || isRequest(input) && input.body !== null) && (method === "GET" || method === "HEAD")) throw new TypeError("Request with GET/HEAD method cannot have body");
			const inputBody = init.body ? init.body : isRequest(input) && input.body !== null ? clone(input) : null;
			super(inputBody, { size: init.size || input.size || 0 });
			const headers = new Headers(init.headers || input.headers || {});
			if (inputBody !== null && !headers.has("Content-Type")) {
				const contentType = extractContentType(inputBody, this);
				if (contentType) headers.set("Content-Type", contentType);
			}
			let signal = isRequest(input) ? input.signal : null;
			if ("signal" in init) signal = init.signal;
			if (signal != null && !isAbortSignal(signal)) throw new TypeError("Expected signal to be an instanceof AbortSignal or EventTarget");
			let referrer = init.referrer == null ? input.referrer : init.referrer;
			if (referrer === "") referrer = "no-referrer";
			else if (referrer) {
				const parsedReferrer = new URL(referrer);
				referrer = /^about:(\/\/)?client$/.test(parsedReferrer) ? "client" : parsedReferrer;
			} else referrer = void 0;
			this[INTERNALS] = {
				method,
				redirect: init.redirect || input.redirect || "follow",
				headers,
				parsedURL,
				signal,
				referrer
			};
			this.follow = init.follow === void 0 ? input.follow === void 0 ? 20 : input.follow : init.follow;
			this.compress = init.compress === void 0 ? input.compress === void 0 ? true : input.compress : init.compress;
			this.counter = init.counter || input.counter || 0;
			this.agent = init.agent || input.agent;
			this.highWaterMark = init.highWaterMark || input.highWaterMark || 16384;
			this.insecureHTTPParser = init.insecureHTTPParser || input.insecureHTTPParser || false;
			this.referrerPolicy = init.referrerPolicy || input.referrerPolicy || "";
		}
		/** @returns {string} */
		get method() {
			return this[INTERNALS].method;
		}
		/** @returns {string} */
		get url() {
			return format(this[INTERNALS].parsedURL);
		}
		/** @returns {Headers} */
		get headers() {
			return this[INTERNALS].headers;
		}
		get redirect() {
			return this[INTERNALS].redirect;
		}
		/** @returns {AbortSignal} */
		get signal() {
			return this[INTERNALS].signal;
		}
		get referrer() {
			if (this[INTERNALS].referrer === "no-referrer") return "";
			if (this[INTERNALS].referrer === "client") return "about:client";
			if (this[INTERNALS].referrer) return this[INTERNALS].referrer.toString();
		}
		get referrerPolicy() {
			return this[INTERNALS].referrerPolicy;
		}
		set referrerPolicy(referrerPolicy) {
			this[INTERNALS].referrerPolicy = validateReferrerPolicy(referrerPolicy);
		}
		/**
		* Clone this request
		*
		* @return  Request
		*/
		clone() {
			return new Request(this);
		}
		get [Symbol.toStringTag]() {
			return "Request";
		}
	};
	Object.defineProperties(Request.prototype, {
		method: { enumerable: true },
		url: { enumerable: true },
		headers: { enumerable: true },
		redirect: { enumerable: true },
		clone: { enumerable: true },
		signal: { enumerable: true },
		referrer: { enumerable: true },
		referrerPolicy: { enumerable: true }
	});
	getNodeRequestOptions = (request) => {
		const { parsedURL } = request[INTERNALS];
		const headers = new Headers(request[INTERNALS].headers);
		if (!headers.has("Accept")) headers.set("Accept", "*/*");
		let contentLengthValue = null;
		if (request.body === null && /^(post|put)$/i.test(request.method)) contentLengthValue = "0";
		if (request.body !== null) {
			const totalBytes = getTotalBytes(request);
			if (typeof totalBytes === "number" && !Number.isNaN(totalBytes)) contentLengthValue = String(totalBytes);
		}
		if (contentLengthValue) headers.set("Content-Length", contentLengthValue);
		if (request.referrerPolicy === "") request.referrerPolicy = DEFAULT_REFERRER_POLICY;
		if (request.referrer && request.referrer !== "no-referrer") request[INTERNALS].referrer = determineRequestsReferrer(request);
		else request[INTERNALS].referrer = "no-referrer";
		if (request[INTERNALS].referrer instanceof URL) headers.set("Referer", request.referrer);
		if (!headers.has("User-Agent")) headers.set("User-Agent", "node-fetch");
		if (request.compress && !headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "gzip, deflate, br");
		let { agent } = request;
		if (typeof agent === "function") agent = agent(parsedURL);
		const search = getSearch(parsedURL);
		return {
			/** @type {URL} */
			parsedURL,
			options: {
				path: parsedURL.pathname + search,
				method: request.method,
				headers: headers[Symbol.for("nodejs.util.inspect.custom")](),
				insecureHTTPParser: request.insecureHTTPParser,
				agent
			}
		};
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/errors/abort-error.js
var AbortError;
var init_abort_error = __esmMin((() => {
	init_base();
	AbortError = class extends FetchBaseError {
		constructor(message, type = "aborted") {
			super(message, type);
		}
	};
}));
//#endregion
//#region node_modules/gaxios/node_modules/node-fetch/src/index.js
/**
* Index.js
*
* a request API compatible with window.fetch
*
* All spec algorithm step numbers are based on https://fetch.spec.whatwg.org/commit-snapshots/ae716822cb3a61843226cd090eefc6589446c1d2/.
*/
/**
* Fetch function
*
* @param   {string | URL | import('./request').default} url - Absolute url or Request instance
* @param   {*} [options_] - Fetch options
* @return  {Promise<import('./response').default>}
*/
async function fetch(url, options_) {
	return new Promise((resolve, reject) => {
		const request = new Request(url, options_);
		const { parsedURL, options } = getNodeRequestOptions(request);
		if (!supportedSchemas.has(parsedURL.protocol)) throw new TypeError(`node-fetch cannot load ${url}. URL scheme "${parsedURL.protocol.replace(/:$/, "")}" is not supported.`);
		if (parsedURL.protocol === "data:") {
			const data = dataUriToBuffer(request.url);
			resolve(new Response(data, { headers: { "Content-Type": data.typeFull } }));
			return;
		}
		const send = (parsedURL.protocol === "https:" ? https : http).request;
		const { signal } = request;
		let response = null;
		const abort = () => {
			const error = new AbortError("The operation was aborted.");
			reject(error);
			if (request.body && request.body instanceof Stream.Readable) request.body.destroy(error);
			if (!response || !response.body) return;
			response.body.emit("error", error);
		};
		if (signal && signal.aborted) {
			abort();
			return;
		}
		const abortAndFinalize = () => {
			abort();
			finalize();
		};
		const request_ = send(parsedURL.toString(), options);
		if (signal) signal.addEventListener("abort", abortAndFinalize);
		const finalize = () => {
			request_.abort();
			if (signal) signal.removeEventListener("abort", abortAndFinalize);
		};
		request_.on("error", (error) => {
			reject(new FetchError(`request to ${request.url} failed, reason: ${error.message}`, "system", error));
			finalize();
		});
		fixResponseChunkedTransferBadEnding(request_, (error) => {
			if (response && response.body) response.body.destroy(error);
		});
		/* c8 ignore next 18 */
		if (process.version < "v14") request_.on("socket", (s) => {
			let endedWithEventsCount;
			s.prependListener("end", () => {
				endedWithEventsCount = s._eventsCount;
			});
			s.prependListener("close", (hadError) => {
				if (response && endedWithEventsCount < s._eventsCount && !hadError) {
					const error = /* @__PURE__ */ new Error("Premature close");
					error.code = "ERR_STREAM_PREMATURE_CLOSE";
					response.body.emit("error", error);
				}
			});
		});
		request_.on("response", (response_) => {
			request_.setTimeout(0);
			const headers = fromRawHeaders(response_.rawHeaders);
			if (isRedirect(response_.statusCode)) {
				const location = headers.get("Location");
				let locationURL = null;
				try {
					locationURL = location === null ? null : new URL(location, request.url);
				} catch {
					if (request.redirect !== "manual") {
						reject(new FetchError(`uri requested responds with an invalid redirect URL: ${location}`, "invalid-redirect"));
						finalize();
						return;
					}
				}
				switch (request.redirect) {
					case "error":
						reject(new FetchError(`uri requested responds with a redirect, redirect mode is set to error: ${request.url}`, "no-redirect"));
						finalize();
						return;
					case "manual": break;
					case "follow": {
						if (locationURL === null) break;
						if (request.counter >= request.follow) {
							reject(new FetchError(`maximum redirect reached at: ${request.url}`, "max-redirect"));
							finalize();
							return;
						}
						const requestOptions = {
							headers: new Headers(request.headers),
							follow: request.follow,
							counter: request.counter + 1,
							agent: request.agent,
							compress: request.compress,
							method: request.method,
							body: clone(request),
							signal: request.signal,
							size: request.size,
							referrer: request.referrer,
							referrerPolicy: request.referrerPolicy
						};
						if (!isDomainOrSubdomain(request.url, locationURL) || !isSameProtocol(request.url, locationURL)) for (const name of [
							"authorization",
							"www-authenticate",
							"cookie",
							"cookie2"
						]) requestOptions.headers.delete(name);
						if (response_.statusCode !== 303 && request.body && options_.body instanceof Stream.Readable) {
							reject(new FetchError("Cannot follow redirect with body being a readable stream", "unsupported-redirect"));
							finalize();
							return;
						}
						if (response_.statusCode === 303 || (response_.statusCode === 301 || response_.statusCode === 302) && request.method === "POST") {
							requestOptions.method = "GET";
							requestOptions.body = void 0;
							requestOptions.headers.delete("content-length");
						}
						const responseReferrerPolicy = parseReferrerPolicyFromHeader(headers);
						if (responseReferrerPolicy) requestOptions.referrerPolicy = responseReferrerPolicy;
						resolve(fetch(new Request(locationURL, requestOptions)));
						finalize();
						return;
					}
					default: return reject(/* @__PURE__ */ new TypeError(`Redirect option '${request.redirect}' is not a valid value of RequestRedirect`));
				}
			}
			if (signal) response_.once("end", () => {
				signal.removeEventListener("abort", abortAndFinalize);
			});
			let body = pipeline(response_, new PassThrough(), (error) => {
				if (error) reject(error);
			});
			/* c8 ignore next 3 */
			if (process.version < "v12.10") response_.on("aborted", abortAndFinalize);
			const responseOptions = {
				url: request.url,
				status: response_.statusCode,
				statusText: response_.statusMessage,
				headers,
				size: request.size,
				counter: request.counter,
				highWaterMark: request.highWaterMark
			};
			const codings = headers.get("Content-Encoding");
			if (!request.compress || request.method === "HEAD" || codings === null || response_.statusCode === 204 || response_.statusCode === 304) {
				response = new Response(body, responseOptions);
				resolve(response);
				return;
			}
			const zlibOptions = {
				flush: zlib.Z_SYNC_FLUSH,
				finishFlush: zlib.Z_SYNC_FLUSH
			};
			if (codings === "gzip" || codings === "x-gzip") {
				body = pipeline(body, zlib.createGunzip(zlibOptions), (error) => {
					if (error) reject(error);
				});
				response = new Response(body, responseOptions);
				resolve(response);
				return;
			}
			if (codings === "deflate" || codings === "x-deflate") {
				const raw = pipeline(response_, new PassThrough(), (error) => {
					if (error) reject(error);
				});
				raw.once("data", (chunk) => {
					if ((chunk[0] & 15) === 8) body = pipeline(body, zlib.createInflate(), (error) => {
						if (error) reject(error);
					});
					else body = pipeline(body, zlib.createInflateRaw(), (error) => {
						if (error) reject(error);
					});
					response = new Response(body, responseOptions);
					resolve(response);
				});
				raw.once("end", () => {
					if (!response) {
						response = new Response(body, responseOptions);
						resolve(response);
					}
				});
				return;
			}
			if (codings === "br") {
				body = pipeline(body, zlib.createBrotliDecompress(), (error) => {
					if (error) reject(error);
				});
				response = new Response(body, responseOptions);
				resolve(response);
				return;
			}
			response = new Response(body, responseOptions);
			resolve(response);
		});
		writeToStream(request_, request).catch(reject);
	});
}
function fixResponseChunkedTransferBadEnding(request, errorCallback) {
	const LAST_CHUNK = Buffer$1.from("0\r\n\r\n");
	let isChunkedTransfer = false;
	let properLastChunkReceived = false;
	let previousChunk;
	request.on("response", (response) => {
		const { headers } = response;
		isChunkedTransfer = headers["transfer-encoding"] === "chunked" && !headers["content-length"];
	});
	request.on("socket", (socket) => {
		const onSocketClose = () => {
			if (isChunkedTransfer && !properLastChunkReceived) {
				const error = /* @__PURE__ */ new Error("Premature close");
				error.code = "ERR_STREAM_PREMATURE_CLOSE";
				errorCallback(error);
			}
		};
		const onData = (buf) => {
			properLastChunkReceived = Buffer$1.compare(buf.slice(-5), LAST_CHUNK) === 0;
			if (!properLastChunkReceived && previousChunk) properLastChunkReceived = Buffer$1.compare(previousChunk.slice(-3), LAST_CHUNK.slice(0, 3)) === 0 && Buffer$1.compare(buf.slice(-2), LAST_CHUNK.slice(3)) === 0;
			previousChunk = buf;
		};
		socket.prependListener("close", onSocketClose);
		socket.on("data", onData);
		request.on("close", () => {
			socket.removeListener("close", onSocketClose);
			socket.removeListener("data", onData);
		});
	});
}
var supportedSchemas;
//#endregion
__esmMin((() => {
	init_dist();
	init_body();
	init_response();
	init_headers();
	init_request();
	init_fetch_error();
	init_abort_error();
	init_is_redirect();
	init_esm_min();
	init_is();
	init_referrer();
	init_from();
	supportedSchemas = new Set([
		"data:",
		"http:",
		"https:"
	]);
}))();
export { fetch as default };
