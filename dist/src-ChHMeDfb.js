import { o as __toESM, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as require_extend, t as require_package } from "./package-Ba7QPmKG.js";
import { Readable } from "stream";
import { Agent } from "https";
//#region node_modules/gaxios/build/esm/src/util.cjs
var require_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = { pkg: require_package() };
}));
//#endregion
//#region node_modules/gaxios/build/esm/src/common.js
var import_extend = /* @__PURE__ */ __toESM(require_extend(), 1);
const pkg = (/* @__PURE__ */ __toESM(require_util(), 1)).default.pkg;
/**
* Support `instanceof` operator for `GaxiosError`s in different versions of this library.
*
* @see {@link GaxiosError[Symbol.hasInstance]}
*/
const GAXIOS_ERROR_SYMBOL = Symbol.for(`${pkg.name}-gaxios-error`);
var GaxiosError = class GaxiosError extends Error {
	config;
	response;
	/**
	* An error code.
	* Can be a system error code, DOMException error name, or any error's 'code' property where it is a `string`.
	*
	* It is only a `number` when the cause is sourced from an API-level error (AIP-193).
	*
	* @see {@link https://nodejs.org/api/errors.html#errorcode error.code}
	* @see {@link https://developer.mozilla.org/en-US/docs/Web/API/DOMException#error_names DOMException#error_names}
	* @see {@link https://google.aip.dev/193#http11json-representation AIP-193}
	*
	* @example
	* 'ECONNRESET'
	*
	* @example
	* 'TimeoutError'
	*
	* @example
	* 500
	*/
	code;
	/**
	* An HTTP Status code.
	* @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Response/status Response#status}
	*
	* @example
	* 500
	*/
	status;
	/**
	* @deprecated use {@link GaxiosError.cause} instead.
	*
	* @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause Error#cause}
	*
	* @privateRemarks
	*
	* We will want to remove this property later as the modern `cause` property is better suited
	* for displaying and relaying nested errors. Keeping this here makes the resulting
	* error log larger than it needs to be.
	*
	*/
	error;
	/**
	* Support `instanceof` operator for `GaxiosError` across builds/duplicated files.
	*
	* @see {@link GAXIOS_ERROR_SYMBOL}
	* @see {@link GaxiosError[Symbol.hasInstance]}
	* @see {@link https://github.com/microsoft/TypeScript/issues/13965#issuecomment-278570200}
	* @see {@link https://stackoverflow.com/questions/46618852/require-and-instanceof}
	* @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/@@hasInstance#reverting_to_default_instanceof_behavior}
	*/
	[GAXIOS_ERROR_SYMBOL] = pkg.version;
	/**
	* Support `instanceof` operator for `GaxiosError` across builds/duplicated files.
	*
	* @see {@link GAXIOS_ERROR_SYMBOL}
	* @see {@link GaxiosError[GAXIOS_ERROR_SYMBOL]}
	*/
	static [Symbol.hasInstance](instance) {
		if (instance && typeof instance === "object" && GAXIOS_ERROR_SYMBOL in instance && instance[GAXIOS_ERROR_SYMBOL] === pkg.version) return true;
		return Function.prototype[Symbol.hasInstance].call(GaxiosError, instance);
	}
	constructor(message, config, response, cause) {
		super(message, { cause });
		this.config = config;
		this.response = response;
		this.error = cause instanceof Error ? cause : void 0;
		this.config = (0, import_extend.default)(true, {}, config);
		if (this.response) this.response.config = (0, import_extend.default)(true, {}, this.response.config);
		if (this.response) {
			try {
				this.response.data = translateData(this.config.responseType, this.response?.bodyUsed ? this.response?.data : void 0);
			} catch {}
			this.status = this.response.status;
		}
		if (cause instanceof DOMException) this.code = cause.name;
		else if (cause && typeof cause === "object" && "code" in cause && (typeof cause.code === "string" || typeof cause.code === "number")) this.code = cause.code;
	}
	/**
	* An AIP-193 conforming error extractor.
	*
	* @see {@link https://google.aip.dev/193#http11json-representation AIP-193}
	*
	* @internal
	* @expiremental
	*
	* @param res the response object
	* @returns the extracted error information
	*/
	static extractAPIErrorFromResponse(res, defaultErrorMessage = "The request failed") {
		let message = defaultErrorMessage;
		if (typeof res.data === "string") message = res.data;
		if (res.data && typeof res.data === "object" && "error" in res.data && res.data.error && !res.ok) {
			if (typeof res.data.error === "string") return {
				message: res.data.error,
				code: res.status,
				status: res.statusText
			};
			if (typeof res.data.error === "object") {
				message = "message" in res.data.error && typeof res.data.error.message === "string" ? res.data.error.message : message;
				const status = "status" in res.data.error && typeof res.data.error.status === "string" ? res.data.error.status : res.statusText;
				const code = "code" in res.data.error && typeof res.data.error.code === "number" ? res.data.error.code : res.status;
				if ("errors" in res.data.error && Array.isArray(res.data.error.errors)) {
					const errorMessages = [];
					for (const e of res.data.error.errors) if (typeof e === "object" && "message" in e && typeof e.message === "string") errorMessages.push(e.message);
					return Object.assign({
						message: errorMessages.join("\n") || message,
						code,
						status
					}, res.data.error);
				}
				return Object.assign({
					message,
					code,
					status
				}, res.data.error);
			}
		}
		return {
			message,
			code: res.status,
			status: res.statusText
		};
	}
};
function translateData(responseType, data) {
	switch (responseType) {
		case "stream": return data;
		case "json": return JSON.parse(JSON.stringify(data));
		case "arraybuffer": return JSON.parse(Buffer.from(data).toString("utf8"));
		case "blob": return JSON.parse(data.text());
		default: return data;
	}
}
/**
* An experimental error redactor.
*
* @param config Config to potentially redact properties of
* @param response Config to potentially redact properties of
*
* @experimental
*/
function defaultErrorRedactor(data) {
	const REDACT = "<<REDACTED> - See `errorRedactor` option in `gaxios` for configuration>.";
	function redactHeaders(headers) {
		if (!headers) return;
		headers.forEach((_, key) => {
			if (/^authentication$/i.test(key) || /^authorization$/i.test(key) || /secret/i.test(key)) headers.set(key, REDACT);
		});
	}
	function redactString(obj, key) {
		if (typeof obj === "object" && obj !== null && typeof obj[key] === "string") {
			const text = obj[key];
			if (/grant_type=/i.test(text) || /assertion=/i.test(text) || /secret/i.test(text)) obj[key] = REDACT;
		}
	}
	function redactObject(obj) {
		if (!obj || typeof obj !== "object") return;
		else if (obj instanceof FormData || obj instanceof URLSearchParams || "forEach" in obj && "set" in obj) obj.forEach((_, key) => {
			if (["grant_type", "assertion"].includes(key) || /secret/.test(key)) obj.set(key, REDACT);
		});
		else {
			if ("grant_type" in obj) obj["grant_type"] = REDACT;
			if ("assertion" in obj) obj["assertion"] = REDACT;
			if ("client_secret" in obj) obj["client_secret"] = REDACT;
		}
	}
	if (data.config) {
		redactHeaders(data.config.headers);
		redactString(data.config, "data");
		redactObject(data.config.data);
		redactString(data.config, "body");
		redactObject(data.config.body);
		if (data.config.url.searchParams.has("token")) data.config.url.searchParams.set("token", REDACT);
		if (data.config.url.searchParams.has("client_secret")) data.config.url.searchParams.set("client_secret", REDACT);
	}
	if (data.response) {
		defaultErrorRedactor({ config: data.response.config });
		redactHeaders(data.response.headers);
		if (data.response.bodyUsed) {
			redactString(data.response, "data");
			redactObject(data.response.data);
		}
	}
	return data;
}
//#endregion
//#region node_modules/gaxios/build/esm/src/retry.js
async function getRetryConfig(err) {
	let config = getConfig(err);
	if (!err || !err.config || !config && !err.config.retry) return { shouldRetry: false };
	config = config || {};
	config.currentRetryAttempt = config.currentRetryAttempt || 0;
	config.retry = config.retry === void 0 || config.retry === null ? 3 : config.retry;
	config.httpMethodsToRetry = config.httpMethodsToRetry || [
		"GET",
		"HEAD",
		"PUT",
		"OPTIONS",
		"DELETE"
	];
	config.noResponseRetries = config.noResponseRetries === void 0 || config.noResponseRetries === null ? 2 : config.noResponseRetries;
	config.retryDelayMultiplier = config.retryDelayMultiplier ? config.retryDelayMultiplier : 2;
	config.timeOfFirstRequest = config.timeOfFirstRequest ? config.timeOfFirstRequest : Date.now();
	config.totalTimeout = config.totalTimeout ? config.totalTimeout : Number.MAX_SAFE_INTEGER;
	config.maxRetryDelay = config.maxRetryDelay ? config.maxRetryDelay : Number.MAX_SAFE_INTEGER;
	config.statusCodesToRetry = config.statusCodesToRetry || [
		[100, 199],
		[408, 408],
		[429, 429],
		[500, 599]
	];
	err.config.retryConfig = config;
	if (!await (config.shouldRetry || shouldRetryRequest)(err)) return {
		shouldRetry: false,
		config: err.config
	};
	const delay = getNextRetryDelay(config);
	err.config.retryConfig.currentRetryAttempt += 1;
	const backoff = config.retryBackoff ? config.retryBackoff(err, delay) : new Promise((resolve) => {
		setTimeout(resolve, delay);
	});
	if (config.onRetryAttempt) await config.onRetryAttempt(err);
	await backoff;
	return {
		shouldRetry: true,
		config: err.config
	};
}
/**
* Determine based on config if we should retry the request.
* @param err The GaxiosError passed to the interceptor.
*/
function shouldRetryRequest(err) {
	const config = getConfig(err);
	if (err.config.signal?.aborted && err.code !== "TimeoutError" || err.code === "AbortError") return false;
	if (!config || config.retry === 0) return false;
	if (!err.response && (config.currentRetryAttempt || 0) >= config.noResponseRetries) return false;
	if (!config.httpMethodsToRetry || !config.httpMethodsToRetry.includes(err.config.method?.toUpperCase() || "GET")) return false;
	if (err.response && err.response.status) {
		let isInRange = false;
		for (const [min, max] of config.statusCodesToRetry) {
			const status = err.response.status;
			if (status >= min && status <= max) {
				isInRange = true;
				break;
			}
		}
		if (!isInRange) return false;
	}
	config.currentRetryAttempt = config.currentRetryAttempt || 0;
	if (config.currentRetryAttempt >= config.retry) return false;
	return true;
}
/**
* Acquire the raxConfig object from an GaxiosError if available.
* @param err The Gaxios error with a config object.
*/
function getConfig(err) {
	if (err && err.config && err.config.retryConfig) return err.config.retryConfig;
}
/**
* Gets the delay to wait before the next retry.
*
* @param {RetryConfig} config The current set of retry options
* @returns {number} the amount of ms to wait before the next retry attempt.
*/
function getNextRetryDelay(config) {
	const calculatedDelay = (config.currentRetryAttempt ? 0 : config.retryDelay ?? 100) + (Math.pow(config.retryDelayMultiplier, config.currentRetryAttempt) - 1) / 2 * 1e3;
	const maxAllowableDelay = config.totalTimeout - (Date.now() - config.timeOfFirstRequest);
	return Math.min(calculatedDelay, maxAllowableDelay, config.maxRetryDelay);
}
//#endregion
//#region node_modules/gaxios/build/esm/src/interceptor.js
/**
* Class to manage collections of GaxiosInterceptors for both requests and responses.
*/
var GaxiosInterceptorManager = class extends Set {};
//#endregion
//#region node_modules/gaxios/build/esm/src/gaxios.js
var _a;
const randomUUID = async () => globalThis.crypto?.randomUUID() || (await import("crypto")).randomUUID();
const HTTP_STATUS_NO_CONTENT = 204;
var Gaxios = class {
	agentCache = /* @__PURE__ */ new Map();
	/**
	* Default HTTP options that will be used for every HTTP request.
	*/
	defaults;
	/**
	* Interceptors
	*/
	interceptors;
	/**
	* The Gaxios class is responsible for making HTTP requests.
	* @param defaults The default set of options to be used for this instance.
	*/
	constructor(defaults) {
		this.defaults = defaults || {};
		this.interceptors = {
			request: new GaxiosInterceptorManager(),
			response: new GaxiosInterceptorManager()
		};
	}
	/**
	* A {@link fetch `fetch`} compliant API for {@link Gaxios}.
	*
	* @remarks
	*
	* This is useful as a drop-in replacement for `fetch` API usage.
	*
	* @example
	*
	* ```ts
	* const gaxios = new Gaxios();
	* const myFetch: typeof fetch = (...args) => gaxios.fetch(...args);
	* await myFetch('https://example.com');
	* ```
	*
	* @param args `fetch` API or `Gaxios#request` parameters
	* @returns the {@link Response} with Gaxios-added properties
	*/
	fetch(...args) {
		const input = args[0];
		const init = args[1];
		let url = void 0;
		const headers = new Headers();
		if (typeof input === "string") url = new URL(input);
		else if (input instanceof URL) url = input;
		else if (input && input.url) url = new URL(input.url);
		if (input && typeof input === "object" && "headers" in input) _a.mergeHeaders(headers, input.headers);
		if (init) _a.mergeHeaders(headers, new Headers(init.headers));
		if (typeof input === "object" && !(input instanceof URL)) return this.request({
			...init,
			...input,
			headers,
			url
		});
		else return this.request({
			...init,
			headers,
			url
		});
	}
	/**
	* Perform an HTTP request with the given options.
	* @param opts Set of HTTP options that will be used for this HTTP request.
	*/
	async request(opts = {}) {
		let prepared = await this.#prepareRequest(opts);
		prepared = await this.#applyRequestInterceptors(prepared);
		return this.#applyResponseInterceptors(this._request(prepared));
	}
	async _defaultAdapter(config) {
		const fetchImpl = config.fetchImplementation || this.defaults.fetchImplementation || await _a.#getFetch();
		const preparedOpts = { ...config };
		delete preparedOpts.data;
		const res = await fetchImpl(config.url, preparedOpts);
		const data = await this.getResponseData(config, res);
		if (!Object.getOwnPropertyDescriptor(res, "data")?.configurable) Object.defineProperties(res, { data: {
			configurable: true,
			writable: true,
			enumerable: true,
			value: data
		} });
		return Object.assign(res, {
			config,
			data
		});
	}
	/**
	* Internal, retryable version of the `request` method.
	* @param opts Set of HTTP options that will be used for this HTTP request.
	*/
	async _request(opts) {
		try {
			let translatedResponse;
			if (opts.adapter) translatedResponse = await opts.adapter(opts, this._defaultAdapter.bind(this));
			else translatedResponse = await this._defaultAdapter(opts);
			if (!opts.validateStatus(translatedResponse.status)) {
				if (opts.responseType === "stream") {
					const response = [];
					for await (const chunk of translatedResponse.data) response.push(chunk);
					translatedResponse.data = response.toString();
				}
				const errorInfo = GaxiosError.extractAPIErrorFromResponse(translatedResponse, `Request failed with status code ${translatedResponse.status}`);
				throw new GaxiosError(errorInfo?.message, opts, translatedResponse, errorInfo);
			}
			return translatedResponse;
		} catch (e) {
			let err;
			if (e instanceof GaxiosError) err = e;
			else if (e instanceof Error) err = new GaxiosError(e.message, opts, void 0, e);
			else err = new GaxiosError("Unexpected Gaxios Error", opts, void 0, e);
			const { shouldRetry, config } = await getRetryConfig(err);
			if (shouldRetry && config) {
				err.config.retryConfig.currentRetryAttempt = config.retryConfig.currentRetryAttempt;
				opts.retryConfig = err.config?.retryConfig;
				this.#appendTimeoutToSignal(opts);
				return this._request(opts);
			}
			if (opts.errorRedactor) opts.errorRedactor(err);
			throw err;
		}
	}
	async getResponseData(opts, res) {
		if (res.status === HTTP_STATUS_NO_CONTENT) return "";
		if (opts.maxContentLength && res.headers.has("content-length") && opts.maxContentLength < Number.parseInt(res.headers?.get("content-length") || "")) throw new GaxiosError("Response's `Content-Length` is over the limit.", opts, Object.assign(res, { config: opts }));
		switch (opts.responseType) {
			case "stream": return res.body;
			case "json": {
				const data = await res.text();
				try {
					return JSON.parse(data);
				} catch {
					return data;
				}
			}
			case "arraybuffer": return res.arrayBuffer();
			case "blob": return res.blob();
			case "text": return res.text();
			default: return this.getResponseDataFromContentType(res);
		}
	}
	#urlMayUseProxy(url, noProxy = []) {
		const candidate = new URL(url);
		const noProxyList = [...noProxy];
		const noProxyEnvList = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") || [];
		for (const rule of noProxyEnvList) noProxyList.push(rule.trim());
		for (const rule of noProxyList) if (rule instanceof RegExp) {
			if (rule.test(candidate.toString())) return false;
		} else if (rule instanceof URL) {
			if (rule.origin === candidate.origin) return false;
		} else if (rule.startsWith("*.") || rule.startsWith(".")) {
			const cleanedRule = rule.replace(/^\*\./, ".");
			if (candidate.hostname.endsWith(cleanedRule)) return false;
		} else if (rule === candidate.origin || rule === candidate.hostname || rule === candidate.href) return false;
		return true;
	}
	/**
	* Applies the request interceptors. The request interceptors are applied after the
	* call to prepareRequest is completed.
	*
	* @param {GaxiosOptionsPrepared} options The current set of options.
	*
	* @returns {Promise<GaxiosOptionsPrepared>} Promise that resolves to the set of options or response after interceptors are applied.
	*/
	async #applyRequestInterceptors(options) {
		let promiseChain = Promise.resolve(options);
		for (const interceptor of this.interceptors.request.values()) if (interceptor) promiseChain = promiseChain.then(interceptor.resolved, interceptor.rejected);
		return promiseChain;
	}
	/**
	* Applies the response interceptors. The response interceptors are applied after the
	* call to request is made.
	*
	* @param {GaxiosOptionsPrepared} options The current set of options.
	*
	* @returns {Promise<GaxiosOptionsPrepared>} Promise that resolves to the set of options or response after interceptors are applied.
	*/
	async #applyResponseInterceptors(response) {
		let promiseChain = Promise.resolve(response);
		for (const interceptor of this.interceptors.response.values()) if (interceptor) promiseChain = promiseChain.then(interceptor.resolved, interceptor.rejected);
		return promiseChain;
	}
	/**
	* Validates the options, merges them with defaults, and prepare request.
	*
	* @param options The original options passed from the client.
	* @returns Prepared options, ready to make a request
	*/
	async #prepareRequest(options) {
		const preparedHeaders = new Headers(this.defaults.headers);
		_a.mergeHeaders(preparedHeaders, options.headers);
		const opts = (0, import_extend.default)(true, {}, this.defaults, options);
		if (!opts.url) throw new Error("URL is required.");
		if (opts.baseURL) opts.url = new URL(opts.url, opts.baseURL);
		opts.url = new URL(opts.url);
		if (opts.params) if (opts.paramsSerializer) {
			let additionalQueryParams = opts.paramsSerializer(opts.params);
			if (additionalQueryParams.startsWith("?")) additionalQueryParams = additionalQueryParams.slice(1);
			const prefix = opts.url.toString().includes("?") ? "&" : "?";
			opts.url = opts.url + prefix + additionalQueryParams;
		} else {
			const url = opts.url instanceof URL ? opts.url : new URL(opts.url);
			for (const [key, value] of new URLSearchParams(opts.params)) url.searchParams.append(key, value);
			opts.url = url;
		}
		if (typeof options.maxContentLength === "number") opts.size = options.maxContentLength;
		if (typeof options.maxRedirects === "number") opts.follow = options.maxRedirects;
		const shouldDirectlyPassData = typeof opts.data === "string" || opts.data instanceof ArrayBuffer || opts.data instanceof Blob || globalThis.File && opts.data instanceof File || opts.data instanceof FormData || opts.data instanceof Readable || opts.data instanceof ReadableStream || opts.data instanceof String || opts.data instanceof URLSearchParams || ArrayBuffer.isView(opts.data) || [
			"Blob",
			"File",
			"FormData"
		].includes(opts.data?.constructor?.name || "");
		if (opts.multipart?.length) {
			const boundary = await randomUUID();
			preparedHeaders.set("content-type", `multipart/related; boundary=${boundary}`);
			opts.body = Readable.from(this.getMultipartRequest(opts.multipart, boundary));
		} else if (shouldDirectlyPassData) opts.body = opts.data;
		else if (typeof opts.data === "object") if (preparedHeaders.get("Content-Type") === "application/x-www-form-urlencoded") opts.body = opts.paramsSerializer ? opts.paramsSerializer(opts.data) : new URLSearchParams(opts.data);
		else {
			if (!preparedHeaders.has("content-type")) preparedHeaders.set("content-type", "application/json");
			opts.body = JSON.stringify(opts.data);
		}
		else if (opts.data) opts.body = opts.data;
		opts.validateStatus = opts.validateStatus || this.validateStatus;
		opts.responseType = opts.responseType || "unknown";
		if (!preparedHeaders.has("accept") && opts.responseType === "json") preparedHeaders.set("accept", "application/json");
		const proxy = opts.proxy || process?.env?.HTTPS_PROXY || process?.env?.https_proxy || process?.env?.HTTP_PROXY || process?.env?.http_proxy;
		if (opts.agent) {} else if (proxy && this.#urlMayUseProxy(opts.url, opts.noProxy)) {
			const HttpsProxyAgent = await _a.#getProxyAgent();
			if (this.agentCache.has(proxy)) opts.agent = this.agentCache.get(proxy);
			else {
				opts.agent = new HttpsProxyAgent(proxy, {
					cert: opts.cert,
					key: opts.key
				});
				this.agentCache.set(proxy, opts.agent);
			}
		} else if (opts.cert && opts.key) if (this.agentCache.has(opts.key)) opts.agent = this.agentCache.get(opts.key);
		else {
			opts.agent = new Agent({
				cert: opts.cert,
				key: opts.key
			});
			this.agentCache.set(opts.key, opts.agent);
		}
		if (typeof opts.errorRedactor !== "function" && opts.errorRedactor !== false) opts.errorRedactor = defaultErrorRedactor;
		if (opts.body && !("duplex" in opts))
 /**
		* required for Node.js and the type isn't available today
		* @link https://github.com/nodejs/node/issues/46221
		* @link https://github.com/microsoft/TypeScript-DOM-lib-generator/issues/1483
		*/
		opts.duplex = "half";
		this.#appendTimeoutToSignal(opts);
		return Object.assign(opts, {
			headers: preparedHeaders,
			url: opts.url instanceof URL ? opts.url : new URL(opts.url)
		});
	}
	#appendTimeoutToSignal(opts) {
		if (opts.timeout) {
			const timeoutSignal = AbortSignal.timeout(opts.timeout);
			if (opts.signal && !opts.signal.aborted) opts.signal = AbortSignal.any([opts.signal, timeoutSignal]);
			else opts.signal = timeoutSignal;
		}
	}
	/**
	* By default, throw for any non-2xx status code
	* @param status status code from the HTTP response
	*/
	validateStatus(status) {
		return status >= 200 && status < 300;
	}
	/**
	* Attempts to parse a response by looking at the Content-Type header.
	* @param {Response} response the HTTP response.
	* @returns a promise that resolves to the response data.
	*/
	async getResponseDataFromContentType(response) {
		let contentType = response.headers.get("Content-Type");
		if (contentType === null) return response.text();
		contentType = contentType.toLowerCase();
		if (contentType.includes("application/json")) {
			let data = await response.text();
			try {
				data = JSON.parse(data);
			} catch {}
			return data;
		} else if (contentType.match(/^text\//)) return response.text();
		else return response.blob();
	}
	/**
	* Creates an async generator that yields the pieces of a multipart/related request body.
	* This implementation follows the spec: https://www.ietf.org/rfc/rfc2387.txt. However, recursive
	* multipart/related requests are not currently supported.
	*
	* @param {GaxiosMultipartOptions[]} multipartOptions the pieces to turn into a multipart/related body.
	* @param {string} boundary the boundary string to be placed between each part.
	*/
	async *getMultipartRequest(multipartOptions, boundary) {
		const finale = `--${boundary}--`;
		for (const currentPart of multipartOptions) {
			yield `--${boundary}\r\nContent-Type: ${currentPart.headers.get("Content-Type") || "application/octet-stream"}\r\n\r\n`;
			if (typeof currentPart.content === "string") yield currentPart.content;
			else yield* currentPart.content;
			yield "\r\n";
		}
		yield finale;
	}
	/**
	* A cache for the lazily-loaded proxy agent.
	*
	* Should use {@link Gaxios[#getProxyAgent]} to retrieve.
	*/
	static #proxyAgent;
	/**
	* A cache for the lazily-loaded fetch library.
	*
	* Should use {@link Gaxios[#getFetch]} to retrieve.
	*/
	static #fetch;
	/**
	* Imports, caches, and returns a proxy agent - if not already imported
	*
	* @returns A proxy agent
	*/
	static async #getProxyAgent() {
		this.#proxyAgent ||= (await import("./dist-D5RpnSXj.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1))).HttpsProxyAgent;
		return this.#proxyAgent;
	}
	static async #getFetch() {
		const hasWindow = typeof window !== "undefined" && !!window;
		this.#fetch ||= hasWindow ? window.fetch : (await import("./src-DXQK8Hfj.js")).default;
		return this.#fetch;
	}
	/**
	* Merges headers.
	* If the base headers do not exist a new `Headers` object will be returned.
	*
	* @remarks
	*
	* Using this utility can be helpful when the headers are not known to exist:
	* - if they exist as `Headers`, that instance will be used
	*   - it improves performance and allows users to use their existing references to their `Headers`
	* - if they exist in another form (`HeadersInit`), they will be used to create a new `Headers` object
	* - if the base headers do not exist a new `Headers` object will be created
	*
	* @param base headers to append/overwrite to
	* @param append headers to append/overwrite with
	* @returns the base headers instance with merged `Headers`
	*/
	static mergeHeaders(base, ...append) {
		base = base instanceof Headers ? base : new Headers(base);
		for (const headers of append) (headers instanceof Headers ? headers : new Headers(headers)).forEach((value, key) => {
			key === "set-cookie" ? base.append(key, value) : base.set(key, value);
		});
		return base;
	}
};
_a = Gaxios;
//#endregion
//#region node_modules/gaxios/build/esm/src/index.js
/**
* The default instance used when the `request` method is directly
* invoked.
*/
const instance = new Gaxios();
/**
* Make an HTTP request using the given options.
* @param opts Options for the request
*/
async function request(opts) {
	return instance.request(opts);
}
//#endregion
export { Gaxios, GaxiosError, GaxiosInterceptorManager, instance, request };
