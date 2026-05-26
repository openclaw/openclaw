import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-HkwdBwDg.js";
import { C as client_exports, _ as serde_exports, g as init_serde, n as protocols_exports, t as init_protocols, w as init_client } from "./protocols-CO3NMy6S.js";
//#region node_modules/@smithy/smithy-client/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createAggregatedClient = exports.convertMap = exports._json = exports.ServiceException = exports.SENSITIVE_STRING = exports.NoOpLogger = exports.Command = exports.Client = exports.strictParseShort = exports.strictParseLong = exports.strictParseInt32 = exports.strictParseInt = exports.strictParseFloat32 = exports.strictParseFloat = exports.strictParseDouble = exports.strictParseByte = exports.splitHeader = exports.splitEvery = exports.quoteHeader = exports.parseRfc7231DateTime = exports.parseRfc3339DateTimeWithOffset = exports.parseRfc3339DateTime = exports.parseEpochTimestamp = exports.parseBoolean = exports.nv = exports.logger = exports.limitedParseFloat32 = exports.limitedParseFloat = exports.limitedParseDouble = exports.handleFloat = exports.generateIdempotencyToken = exports.expectUnion = exports.expectString = exports.expectShort = exports.expectObject = exports.expectNumber = exports.expectNonNull = exports.expectLong = exports.expectInt32 = exports.expectInt = exports.expectFloat32 = exports.expectByte = exports.expectBoolean = exports.dateToUtcString = exports.copyDocumentWithTransform = exports._parseRfc7231DateTime = exports._parseRfc3339DateTimeWithOffset = exports._parseEpochTimestamp = exports.NumericValue = exports.LazyJsonString = void 0;
	exports.resolvedPath = exports.extendedEncodeURIComponent = exports.collectBody = exports.withBaseException = exports.throwDefaultError = exports.take = exports.serializeFloat = exports.serializeDateTime = exports.resolveDefaultRuntimeConfig = exports.map = exports.loadConfigsForDefaultMode = exports.isSerializableHeaderValue = exports.getValueFromTextNode = exports.getDefaultExtensionConfiguration = exports.getDefaultClientConfiguration = exports.getArrayIfSingleItem = exports.emitWarningIfUnsupportedVersion = exports.decorateServiceException = void 0;
	var serde_1 = (init_serde(), __toCommonJS(serde_exports));
	Object.defineProperty(exports, "LazyJsonString", {
		enumerable: true,
		get: function() {
			return serde_1.LazyJsonString;
		}
	});
	Object.defineProperty(exports, "NumericValue", {
		enumerable: true,
		get: function() {
			return serde_1.NumericValue;
		}
	});
	Object.defineProperty(exports, "_parseEpochTimestamp", {
		enumerable: true,
		get: function() {
			return serde_1._parseEpochTimestamp;
		}
	});
	Object.defineProperty(exports, "_parseRfc3339DateTimeWithOffset", {
		enumerable: true,
		get: function() {
			return serde_1._parseRfc3339DateTimeWithOffset;
		}
	});
	Object.defineProperty(exports, "_parseRfc7231DateTime", {
		enumerable: true,
		get: function() {
			return serde_1._parseRfc7231DateTime;
		}
	});
	Object.defineProperty(exports, "copyDocumentWithTransform", {
		enumerable: true,
		get: function() {
			return serde_1.copyDocumentWithTransform;
		}
	});
	Object.defineProperty(exports, "dateToUtcString", {
		enumerable: true,
		get: function() {
			return serde_1.dateToUtcString;
		}
	});
	Object.defineProperty(exports, "expectBoolean", {
		enumerable: true,
		get: function() {
			return serde_1.expectBoolean;
		}
	});
	Object.defineProperty(exports, "expectByte", {
		enumerable: true,
		get: function() {
			return serde_1.expectByte;
		}
	});
	Object.defineProperty(exports, "expectFloat32", {
		enumerable: true,
		get: function() {
			return serde_1.expectFloat32;
		}
	});
	Object.defineProperty(exports, "expectInt", {
		enumerable: true,
		get: function() {
			return serde_1.expectInt;
		}
	});
	Object.defineProperty(exports, "expectInt32", {
		enumerable: true,
		get: function() {
			return serde_1.expectInt32;
		}
	});
	Object.defineProperty(exports, "expectLong", {
		enumerable: true,
		get: function() {
			return serde_1.expectLong;
		}
	});
	Object.defineProperty(exports, "expectNonNull", {
		enumerable: true,
		get: function() {
			return serde_1.expectNonNull;
		}
	});
	Object.defineProperty(exports, "expectNumber", {
		enumerable: true,
		get: function() {
			return serde_1.expectNumber;
		}
	});
	Object.defineProperty(exports, "expectObject", {
		enumerable: true,
		get: function() {
			return serde_1.expectObject;
		}
	});
	Object.defineProperty(exports, "expectShort", {
		enumerable: true,
		get: function() {
			return serde_1.expectShort;
		}
	});
	Object.defineProperty(exports, "expectString", {
		enumerable: true,
		get: function() {
			return serde_1.expectString;
		}
	});
	Object.defineProperty(exports, "expectUnion", {
		enumerable: true,
		get: function() {
			return serde_1.expectUnion;
		}
	});
	Object.defineProperty(exports, "generateIdempotencyToken", {
		enumerable: true,
		get: function() {
			return serde_1.generateIdempotencyToken;
		}
	});
	Object.defineProperty(exports, "handleFloat", {
		enumerable: true,
		get: function() {
			return serde_1.handleFloat;
		}
	});
	Object.defineProperty(exports, "limitedParseDouble", {
		enumerable: true,
		get: function() {
			return serde_1.limitedParseDouble;
		}
	});
	Object.defineProperty(exports, "limitedParseFloat", {
		enumerable: true,
		get: function() {
			return serde_1.limitedParseFloat;
		}
	});
	Object.defineProperty(exports, "limitedParseFloat32", {
		enumerable: true,
		get: function() {
			return serde_1.limitedParseFloat32;
		}
	});
	Object.defineProperty(exports, "logger", {
		enumerable: true,
		get: function() {
			return serde_1.logger;
		}
	});
	Object.defineProperty(exports, "nv", {
		enumerable: true,
		get: function() {
			return serde_1.nv;
		}
	});
	Object.defineProperty(exports, "parseBoolean", {
		enumerable: true,
		get: function() {
			return serde_1.parseBoolean;
		}
	});
	Object.defineProperty(exports, "parseEpochTimestamp", {
		enumerable: true,
		get: function() {
			return serde_1.parseEpochTimestamp;
		}
	});
	Object.defineProperty(exports, "parseRfc3339DateTime", {
		enumerable: true,
		get: function() {
			return serde_1.parseRfc3339DateTime;
		}
	});
	Object.defineProperty(exports, "parseRfc3339DateTimeWithOffset", {
		enumerable: true,
		get: function() {
			return serde_1.parseRfc3339DateTimeWithOffset;
		}
	});
	Object.defineProperty(exports, "parseRfc7231DateTime", {
		enumerable: true,
		get: function() {
			return serde_1.parseRfc7231DateTime;
		}
	});
	Object.defineProperty(exports, "quoteHeader", {
		enumerable: true,
		get: function() {
			return serde_1.quoteHeader;
		}
	});
	Object.defineProperty(exports, "splitEvery", {
		enumerable: true,
		get: function() {
			return serde_1.splitEvery;
		}
	});
	Object.defineProperty(exports, "splitHeader", {
		enumerable: true,
		get: function() {
			return serde_1.splitHeader;
		}
	});
	Object.defineProperty(exports, "strictParseByte", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseByte;
		}
	});
	Object.defineProperty(exports, "strictParseDouble", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseDouble;
		}
	});
	Object.defineProperty(exports, "strictParseFloat", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseFloat;
		}
	});
	Object.defineProperty(exports, "strictParseFloat32", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseFloat32;
		}
	});
	Object.defineProperty(exports, "strictParseInt", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseInt;
		}
	});
	Object.defineProperty(exports, "strictParseInt32", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseInt32;
		}
	});
	Object.defineProperty(exports, "strictParseLong", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseLong;
		}
	});
	Object.defineProperty(exports, "strictParseShort", {
		enumerable: true,
		get: function() {
			return serde_1.strictParseShort;
		}
	});
	var client_1 = (init_client(), __toCommonJS(client_exports));
	Object.defineProperty(exports, "Client", {
		enumerable: true,
		get: function() {
			return client_1.Client;
		}
	});
	Object.defineProperty(exports, "Command", {
		enumerable: true,
		get: function() {
			return client_1.Command;
		}
	});
	Object.defineProperty(exports, "NoOpLogger", {
		enumerable: true,
		get: function() {
			return client_1.NoOpLogger;
		}
	});
	Object.defineProperty(exports, "SENSITIVE_STRING", {
		enumerable: true,
		get: function() {
			return client_1.SENSITIVE_STRING;
		}
	});
	Object.defineProperty(exports, "ServiceException", {
		enumerable: true,
		get: function() {
			return client_1.ServiceException;
		}
	});
	Object.defineProperty(exports, "_json", {
		enumerable: true,
		get: function() {
			return client_1._json;
		}
	});
	Object.defineProperty(exports, "convertMap", {
		enumerable: true,
		get: function() {
			return client_1.convertMap;
		}
	});
	Object.defineProperty(exports, "createAggregatedClient", {
		enumerable: true,
		get: function() {
			return client_1.createAggregatedClient;
		}
	});
	Object.defineProperty(exports, "decorateServiceException", {
		enumerable: true,
		get: function() {
			return client_1.decorateServiceException;
		}
	});
	Object.defineProperty(exports, "emitWarningIfUnsupportedVersion", {
		enumerable: true,
		get: function() {
			return client_1.emitWarningIfUnsupportedVersion;
		}
	});
	Object.defineProperty(exports, "getArrayIfSingleItem", {
		enumerable: true,
		get: function() {
			return client_1.getArrayIfSingleItem;
		}
	});
	Object.defineProperty(exports, "getDefaultClientConfiguration", {
		enumerable: true,
		get: function() {
			return client_1.getDefaultClientConfiguration;
		}
	});
	Object.defineProperty(exports, "getDefaultExtensionConfiguration", {
		enumerable: true,
		get: function() {
			return client_1.getDefaultExtensionConfiguration;
		}
	});
	Object.defineProperty(exports, "getValueFromTextNode", {
		enumerable: true,
		get: function() {
			return client_1.getValueFromTextNode;
		}
	});
	Object.defineProperty(exports, "isSerializableHeaderValue", {
		enumerable: true,
		get: function() {
			return client_1.isSerializableHeaderValue;
		}
	});
	Object.defineProperty(exports, "loadConfigsForDefaultMode", {
		enumerable: true,
		get: function() {
			return client_1.loadConfigsForDefaultMode;
		}
	});
	Object.defineProperty(exports, "map", {
		enumerable: true,
		get: function() {
			return client_1.map;
		}
	});
	Object.defineProperty(exports, "resolveDefaultRuntimeConfig", {
		enumerable: true,
		get: function() {
			return client_1.resolveDefaultRuntimeConfig;
		}
	});
	Object.defineProperty(exports, "serializeDateTime", {
		enumerable: true,
		get: function() {
			return client_1.serializeDateTime;
		}
	});
	Object.defineProperty(exports, "serializeFloat", {
		enumerable: true,
		get: function() {
			return client_1.serializeFloat;
		}
	});
	Object.defineProperty(exports, "take", {
		enumerable: true,
		get: function() {
			return client_1.take;
		}
	});
	Object.defineProperty(exports, "throwDefaultError", {
		enumerable: true,
		get: function() {
			return client_1.throwDefaultError;
		}
	});
	Object.defineProperty(exports, "withBaseException", {
		enumerable: true,
		get: function() {
			return client_1.withBaseException;
		}
	});
	var protocols_1 = (init_protocols(), __toCommonJS(protocols_exports));
	Object.defineProperty(exports, "collectBody", {
		enumerable: true,
		get: function() {
			return protocols_1.collectBody;
		}
	});
	Object.defineProperty(exports, "extendedEncodeURIComponent", {
		enumerable: true,
		get: function() {
			return protocols_1.extendedEncodeURIComponent;
		}
	});
	Object.defineProperty(exports, "resolvedPath", {
		enumerable: true,
		get: function() {
			return protocols_1.resolvedPath;
		}
	});
}));
//#endregion
//#region node_modules/@smithy/node-http-handler/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_https = __require("node:https");
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var node_stream = __require("node:stream");
	var http2 = __require("node:http2");
	function buildAbortError(abortSignal) {
		const reason = abortSignal && typeof abortSignal === "object" && "reason" in abortSignal ? abortSignal.reason : void 0;
		if (reason) {
			if (reason instanceof Error) {
				const abortError = /* @__PURE__ */ new Error("Request aborted");
				abortError.name = "AbortError";
				abortError.cause = reason;
				return abortError;
			}
			const abortError = new Error(String(reason));
			abortError.name = "AbortError";
			return abortError;
		}
		const abortError = /* @__PURE__ */ new Error("Request aborted");
		abortError.name = "AbortError";
		return abortError;
	}
	const NODEJS_TIMEOUT_ERROR_CODES = [
		"ECONNRESET",
		"EPIPE",
		"ETIMEDOUT"
	];
	const getTransformedHeaders = (headers) => {
		const transformedHeaders = {};
		for (const name in headers) {
			const headerValues = headers[name];
			transformedHeaders[name] = Array.isArray(headerValues) ? headerValues.join(",") : headerValues;
		}
		return transformedHeaders;
	};
	const timing = {
		setTimeout: (cb, ms) => setTimeout(cb, ms),
		clearTimeout: (timeoutId) => clearTimeout(timeoutId)
	};
	const DEFER_EVENT_LISTENER_TIME$2 = 1e3;
	const setConnectionTimeout = (request, reject, timeoutInMs = 0) => {
		if (!timeoutInMs) return -1;
		const registerTimeout = (offset) => {
			const timeoutId = timing.setTimeout(() => {
				request.destroy();
				reject(Object.assign(/* @__PURE__ */ new Error(`@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of ${timeoutInMs} ms.`), { name: "TimeoutError" }));
			}, timeoutInMs - offset);
			const doWithSocket = (socket) => {
				if (socket?.connecting) socket.on("connect", () => {
					timing.clearTimeout(timeoutId);
				});
				else timing.clearTimeout(timeoutId);
			};
			if (request.socket) doWithSocket(request.socket);
			else request.on("socket", doWithSocket);
		};
		if (timeoutInMs < 2e3) {
			registerTimeout(0);
			return 0;
		}
		return timing.setTimeout(registerTimeout.bind(null, DEFER_EVENT_LISTENER_TIME$2), DEFER_EVENT_LISTENER_TIME$2);
	};
	const setRequestTimeout = (req, reject, timeoutInMs = 0, throwOnRequestTimeout, logger) => {
		if (timeoutInMs) return timing.setTimeout(() => {
			let msg = `@smithy/node-http-handler - [${throwOnRequestTimeout ? "ERROR" : "WARN"}] a request has exceeded the configured ${timeoutInMs} ms requestTimeout.`;
			if (throwOnRequestTimeout) {
				const error = Object.assign(new Error(msg), {
					name: "TimeoutError",
					code: "ETIMEDOUT"
				});
				req.destroy(error);
				reject(error);
			} else {
				msg += ` Init client requestHandler with throwOnRequestTimeout=true to turn this into an error.`;
				logger?.warn?.(msg);
			}
		}, timeoutInMs);
		return -1;
	};
	const DEFER_EVENT_LISTENER_TIME$1 = 3e3;
	const setSocketKeepAlive = (request, { keepAlive, keepAliveMsecs }, deferTimeMs = DEFER_EVENT_LISTENER_TIME$1) => {
		if (keepAlive !== true) return -1;
		const registerListener = () => {
			if (request.socket) request.socket.setKeepAlive(keepAlive, keepAliveMsecs || 0);
			else request.on("socket", (socket) => {
				socket.setKeepAlive(keepAlive, keepAliveMsecs || 0);
			});
		};
		if (deferTimeMs === 0) {
			registerListener();
			return 0;
		}
		return timing.setTimeout(registerListener, deferTimeMs);
	};
	const DEFER_EVENT_LISTENER_TIME = 3e3;
	const setSocketTimeout = (request, reject, timeoutInMs = 0) => {
		const registerTimeout = (offset) => {
			const timeout = timeoutInMs - offset;
			const onTimeout = () => {
				request.destroy();
				reject(Object.assign(/* @__PURE__ */ new Error(`@smithy/node-http-handler - the request socket timed out after ${timeoutInMs} ms of inactivity (configured by client requestHandler).`), { name: "TimeoutError" }));
			};
			if (request.socket) {
				request.socket.setTimeout(timeout, onTimeout);
				request.on("close", () => request.socket?.removeListener("timeout", onTimeout));
			} else request.setTimeout(timeout, onTimeout);
		};
		if (0 < timeoutInMs && timeoutInMs < 6e3) {
			registerTimeout(0);
			return 0;
		}
		return timing.setTimeout(registerTimeout.bind(null, timeoutInMs === 0 ? 0 : DEFER_EVENT_LISTENER_TIME), DEFER_EVENT_LISTENER_TIME);
	};
	const MIN_WAIT_TIME = 6e3;
	async function writeRequestBody(httpRequest, request, maxContinueTimeoutMs = MIN_WAIT_TIME, externalAgent = false) {
		const headers = request.headers;
		const expect = headers ? headers.Expect || headers.expect : void 0;
		let timeoutId = -1;
		let sendBody = true;
		if (!externalAgent && expect === "100-continue") sendBody = await Promise.race([new Promise((resolve) => {
			timeoutId = Number(timing.setTimeout(() => resolve(true), Math.max(MIN_WAIT_TIME, maxContinueTimeoutMs)));
		}), new Promise((resolve) => {
			httpRequest.on("continue", () => {
				timing.clearTimeout(timeoutId);
				resolve(true);
			});
			httpRequest.on("response", () => {
				timing.clearTimeout(timeoutId);
				resolve(false);
			});
			httpRequest.on("error", () => {
				timing.clearTimeout(timeoutId);
				resolve(false);
			});
		})]);
		if (sendBody) writeBody(httpRequest, request.body);
	}
	function writeBody(httpRequest, body) {
		if (body instanceof node_stream.Readable) {
			body.pipe(httpRequest);
			return;
		}
		if (body) {
			const isBuffer = Buffer.isBuffer(body);
			if (isBuffer || typeof body === "string") {
				if (isBuffer && body.byteLength === 0) httpRequest.end();
				else httpRequest.end(body);
				return;
			}
			const uint8 = body;
			if (typeof uint8 === "object" && uint8.buffer && typeof uint8.byteOffset === "number" && typeof uint8.byteLength === "number") {
				httpRequest.end(Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength));
				return;
			}
			httpRequest.end(Buffer.from(body));
			return;
		}
		httpRequest.end();
	}
	const DEFAULT_REQUEST_TIMEOUT = 0;
	let hAgent = void 0;
	let hRequest = void 0;
	var NodeHttpHandler = class NodeHttpHandler {
		config;
		configProvider;
		socketWarningTimestamp = 0;
		externalAgent = false;
		metadata = { handlerProtocol: "http/1.1" };
		static create(instanceOrOptions) {
			if (typeof instanceOrOptions?.handle === "function") return instanceOrOptions;
			return new NodeHttpHandler(instanceOrOptions);
		}
		static checkSocketUsage(agent, socketWarningTimestamp, logger = console) {
			const { sockets, requests, maxSockets } = agent;
			if (typeof maxSockets !== "number" || maxSockets === Infinity) return socketWarningTimestamp;
			if (Date.now() - 15e3 < socketWarningTimestamp) return socketWarningTimestamp;
			if (sockets && requests) for (const origin in sockets) {
				const socketsInUse = sockets[origin]?.length ?? 0;
				const requestsEnqueued = requests[origin]?.length ?? 0;
				if (socketsInUse >= maxSockets && requestsEnqueued >= 2 * maxSockets) {
					logger?.warn?.(`@smithy/node-http-handler:WARN - socket usage at capacity=${socketsInUse} and ${requestsEnqueued} additional requests are enqueued.
See https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html
or increase socketAcquisitionWarningTimeout=(millis) in the NodeHttpHandler config.`);
					return Date.now();
				}
			}
			return socketWarningTimestamp;
		}
		constructor(options) {
			this.configProvider = new Promise((resolve, reject) => {
				if (typeof options === "function") options().then((_options) => {
					resolve(this.resolveDefaultConfig(_options));
				}).catch(reject);
				else resolve(this.resolveDefaultConfig(options));
			});
		}
		destroy() {
			this.config?.httpAgent?.destroy();
			this.config?.httpsAgent?.destroy();
		}
		async handle(request, { abortSignal, requestTimeout } = {}) {
			if (!this.config) this.config = await this.configProvider;
			const config = this.config;
			const isSSL = request.protocol === "https:";
			if (!isSSL && !this.config.httpAgent) this.config.httpAgent = await this.config.httpAgentProvider();
			return new Promise((_resolve, _reject) => {
				let writeRequestBodyPromise = void 0;
				let socketWarningTimeoutId = -1;
				let connectionTimeoutId = -1;
				let requestTimeoutId = -1;
				let socketTimeoutId = -1;
				let keepAliveTimeoutId = -1;
				const clearTimeouts = () => {
					timing.clearTimeout(socketWarningTimeoutId);
					timing.clearTimeout(connectionTimeoutId);
					timing.clearTimeout(requestTimeoutId);
					timing.clearTimeout(socketTimeoutId);
					timing.clearTimeout(keepAliveTimeoutId);
				};
				const resolve = async (arg) => {
					await writeRequestBodyPromise;
					clearTimeouts();
					_resolve(arg);
				};
				const reject = async (arg) => {
					await writeRequestBodyPromise;
					clearTimeouts();
					_reject(arg);
				};
				if (abortSignal?.aborted) {
					reject(buildAbortError(abortSignal));
					return;
				}
				const headers = request.headers;
				const expectContinue = headers ? (headers.Expect ?? headers.expect) === "100-continue" : false;
				let agent = isSSL ? config.httpsAgent : config.httpAgent;
				if (expectContinue && !this.externalAgent) agent = new (isSSL ? node_https.Agent : hAgent)({
					keepAlive: false,
					maxSockets: Infinity
				});
				socketWarningTimeoutId = timing.setTimeout(() => {
					this.socketWarningTimestamp = NodeHttpHandler.checkSocketUsage(agent, this.socketWarningTimestamp, config.logger);
				}, config.socketAcquisitionWarningTimeout ?? (config.requestTimeout ?? 2e3) + (config.connectionTimeout ?? 1e3));
				const queryString = request.query ? protocols.buildQueryString(request.query) : "";
				let auth = void 0;
				if (request.username != null || request.password != null) auth = `${request.username ?? ""}:${request.password ?? ""}`;
				let path = request.path;
				if (queryString) path += `?${queryString}`;
				if (request.fragment) path += `#${request.fragment}`;
				let hostname = request.hostname ?? "";
				if (hostname[0] === "[" && hostname.endsWith("]")) hostname = request.hostname.slice(1, -1);
				else hostname = request.hostname;
				const nodeHttpsOptions = {
					headers: request.headers,
					host: hostname,
					method: request.method,
					path,
					port: request.port,
					agent,
					auth
				};
				const req = (isSSL ? node_https.request : hRequest)(nodeHttpsOptions, (res) => {
					resolve({ response: new protocols.HttpResponse({
						statusCode: res.statusCode || -1,
						reason: res.statusMessage,
						headers: getTransformedHeaders(res.headers),
						body: res
					}) });
				});
				req.on("error", (err) => {
					if (NODEJS_TIMEOUT_ERROR_CODES.includes(err.code)) reject(Object.assign(err, { name: "TimeoutError" }));
					else reject(err);
				});
				if (abortSignal) {
					const onAbort = () => {
						req.destroy();
						reject(buildAbortError(abortSignal));
					};
					if (typeof abortSignal.addEventListener === "function") {
						const signal = abortSignal;
						signal.addEventListener("abort", onAbort, { once: true });
						req.once("close", () => signal.removeEventListener("abort", onAbort));
					} else abortSignal.onabort = onAbort;
				}
				const effectiveRequestTimeout = requestTimeout ?? config.requestTimeout;
				connectionTimeoutId = setConnectionTimeout(req, reject, config.connectionTimeout);
				requestTimeoutId = setRequestTimeout(req, reject, effectiveRequestTimeout, config.throwOnRequestTimeout, config.logger ?? console);
				socketTimeoutId = setSocketTimeout(req, reject, config.socketTimeout);
				const httpAgent = nodeHttpsOptions.agent;
				if (typeof httpAgent === "object" && "keepAlive" in httpAgent) keepAliveTimeoutId = setSocketKeepAlive(req, {
					keepAlive: httpAgent.keepAlive,
					keepAliveMsecs: httpAgent.keepAliveMsecs
				});
				writeRequestBodyPromise = writeRequestBody(req, request, effectiveRequestTimeout, this.externalAgent).catch((e) => {
					clearTimeouts();
					return _reject(e);
				});
			});
		}
		updateHttpClientConfig(key, value) {
			this.config = void 0;
			this.configProvider = this.configProvider.then((config) => {
				return {
					...config,
					[key]: value
				};
			});
		}
		httpHandlerConfigs() {
			return this.config ?? {};
		}
		resolveDefaultConfig(options) {
			const { requestTimeout, connectionTimeout, socketTimeout, socketAcquisitionWarningTimeout, httpAgent, httpsAgent, throwOnRequestTimeout, logger } = options || {};
			const keepAlive = true;
			const maxSockets = 50;
			return {
				connectionTimeout,
				requestTimeout,
				socketTimeout,
				socketAcquisitionWarningTimeout,
				throwOnRequestTimeout,
				httpAgentProvider: async () => {
					const { Agent, request } = await import("node:http");
					hRequest = request;
					hAgent = Agent;
					if (httpAgent instanceof hAgent || typeof httpAgent?.destroy === "function") {
						this.externalAgent = true;
						return httpAgent;
					}
					return new hAgent({
						keepAlive,
						maxSockets,
						...httpAgent
					});
				},
				httpsAgent: (() => {
					if (httpsAgent instanceof node_https.Agent || typeof httpsAgent?.destroy === "function") {
						this.externalAgent = true;
						return httpsAgent;
					}
					return new node_https.Agent({
						keepAlive,
						maxSockets,
						...httpsAgent
					});
				})(),
				logger
			};
		}
	};
	const ids = new Uint16Array(1);
	var ClientHttp2SessionRef = class {
		id = ids[0]++;
		total = 0;
		max = 0;
		session;
		refs = 0;
		constructor(session) {
			session.unref();
			this.session = session;
		}
		retain() {
			if (this.session.destroyed) throw new Error("@smithy/node-http-handler - cannot acquire reference to destroyed session.");
			this.refs += 1;
			this.total += 1;
			this.max = Math.max(this.refs, this.max);
			this.session.ref();
		}
		free() {
			if (this.session.destroyed) return;
			this.refs -= 1;
			if (this.refs === 0) this.session.unref();
			if (this.refs < 0) throw new Error("@smithy/node-http-handler - ClientHttp2Session refcount at zero, cannot decrement.");
		}
		deref() {
			return this.session;
		}
		close() {
			if (!this.session.closed) this.session.close();
		}
		destroy() {
			this.refs = 0;
			if (!this.session.destroyed) this.session.destroy();
		}
		useCount() {
			return this.refs;
		}
	};
	var NodeHttp2ConnectionPool = class {
		sessions = [];
		maxConcurrency = 0;
		constructor(sessions) {
			this.sessions = (sessions ?? []).map((session) => new ClientHttp2SessionRef(session));
		}
		poll() {
			let cleanup = false;
			for (const session of this.sessions) {
				if (session.deref().destroyed) {
					cleanup = true;
					continue;
				}
				if (!this.maxConcurrency || session.useCount() < this.maxConcurrency) return session;
			}
			if (cleanup) {
				for (const session of this.sessions) if (session.deref().destroyed) this.remove(session);
			}
		}
		offerLast(ref) {
			this.sessions.push(ref);
		}
		remove(ref) {
			const ix = this.sessions.indexOf(ref);
			if (ix > -1) this.sessions.splice(ix, 1);
		}
		[Symbol.iterator]() {
			return this.sessions[Symbol.iterator]();
		}
		setMaxConcurrency(maxConcurrency) {
			this.maxConcurrency = maxConcurrency;
		}
		destroy(ref) {
			this.remove(ref);
			ref.destroy();
		}
	};
	var NodeHttp2ConnectionManager = class {
		config;
		connectOptions;
		connectionPools = /* @__PURE__ */ new Map();
		constructor(config) {
			this.config = config;
			if (this.config.maxConcurrency && this.config.maxConcurrency <= 0) throw new RangeError("maxConcurrency must be greater than zero.");
		}
		lease(requestContext, connectionConfiguration) {
			const url = this.getUrlString(requestContext);
			const pool = this.getPool(url);
			if (!this.config.disableConcurrency && !connectionConfiguration.isEventStream) {
				const available = pool.poll();
				if (available) {
					available.retain();
					return available;
				}
			}
			const ref = new ClientHttp2SessionRef(this.connect(url));
			const session = ref.deref();
			if (this.config.maxConcurrency) session.settings({ maxConcurrentStreams: this.config.maxConcurrency }, (err) => {
				if (err) throw new Error("Fail to set maxConcurrentStreams to " + this.config.maxConcurrency + "when creating new session for " + requestContext.destination.toString());
			});
			const graceful = () => {
				this.removeFromPoolAndClose(url, ref);
			};
			const ensureDestroyed = () => {
				this.removeFromPoolAndCheckedDestroy(url, ref);
			};
			session.on("goaway", graceful);
			session.on("error", ensureDestroyed);
			session.on("frameError", ensureDestroyed);
			session.on("close", ensureDestroyed);
			if (connectionConfiguration.requestTimeout) session.setTimeout(connectionConfiguration.requestTimeout, ensureDestroyed);
			pool.offerLast(ref);
			ref.retain();
			return ref;
		}
		release(_requestContext, ref) {
			ref.free();
		}
		createIsolatedSession(requestContext, connectionConfiguration) {
			const url = this.getUrlString(requestContext);
			const ref = new ClientHttp2SessionRef(this.connect(url));
			const session = ref.deref();
			session.settings({ maxConcurrentStreams: 1 });
			const ensureDestroyed = () => {
				ref.destroy();
			};
			session.on("error", ensureDestroyed);
			session.on("frameError", ensureDestroyed);
			session.on("close", ensureDestroyed);
			if (connectionConfiguration.requestTimeout) session.setTimeout(connectionConfiguration.requestTimeout, ensureDestroyed);
			ref.retain();
			return ref;
		}
		destroy() {
			for (const [url, connectionPool] of this.connectionPools) {
				for (const session of [...connectionPool]) session.destroy();
				this.connectionPools.delete(url);
			}
		}
		setMaxConcurrentStreams(maxConcurrentStreams) {
			if (maxConcurrentStreams && maxConcurrentStreams <= 0) throw new RangeError("maxConcurrentStreams must be greater than zero.");
			this.config.maxConcurrency = maxConcurrentStreams;
			for (const pool of this.connectionPools.values()) pool.setMaxConcurrency(maxConcurrentStreams);
		}
		setDisableConcurrentStreams(disableConcurrentStreams) {
			this.config.disableConcurrency = disableConcurrentStreams;
		}
		setNodeHttp2ConnectOptions(nodeHttp2ConnectOptions) {
			this.connectOptions = nodeHttp2ConnectOptions;
		}
		debug() {
			const pools = {};
			for (const [url, pool] of this.connectionPools) {
				const sessions = [];
				for (const ref of pool) sessions.push({
					id: ref.id,
					active: ref.useCount(),
					maxConcurrent: ref.max,
					totalRequests: ref.total
				});
				pools[url] = { sessions };
			}
			return pools;
		}
		removeFromPoolAndClose(authority, ref) {
			this.connectionPools.get(authority)?.remove(ref);
			ref.close();
		}
		removeFromPoolAndCheckedDestroy(authority, ref) {
			this.connectionPools.get(authority)?.remove(ref);
			ref.destroy();
		}
		getPool(url) {
			if (!this.connectionPools.has(url)) {
				const pool = new NodeHttp2ConnectionPool();
				if (this.config.maxConcurrency) pool.setMaxConcurrency(this.config.maxConcurrency);
				this.connectionPools.set(url, pool);
			}
			return this.connectionPools.get(url);
		}
		getUrlString(request) {
			return request.destination.toString();
		}
		connect(url) {
			return this.connectOptions === void 0 ? http2.connect(url) : http2.connect(url, this.connectOptions);
		}
	};
	var NodeHttp2Handler = class NodeHttp2Handler {
		config;
		configProvider;
		metadata = { handlerProtocol: "h2" };
		connectionManager = new NodeHttp2ConnectionManager({});
		static create(instanceOrOptions) {
			if (typeof instanceOrOptions?.handle === "function") return instanceOrOptions;
			return new NodeHttp2Handler(instanceOrOptions);
		}
		constructor(options) {
			this.configProvider = new Promise((resolve, reject) => {
				if (typeof options === "function") options().then((opts) => {
					resolve(opts || {});
				}).catch(reject);
				else resolve(options || {});
			});
		}
		destroy() {
			this.connectionManager.destroy();
		}
		async handle(request, { abortSignal, requestTimeout, isEventStream } = {}) {
			if (!this.config) {
				this.config = await this.configProvider;
				const { disableConcurrentStreams, maxConcurrentStreams, nodeHttp2ConnectOptions } = this.config;
				this.connectionManager.setDisableConcurrentStreams(disableConcurrentStreams ?? false);
				if (maxConcurrentStreams) this.connectionManager.setMaxConcurrentStreams(maxConcurrentStreams);
				if (nodeHttp2ConnectOptions) this.connectionManager.setNodeHttp2ConnectOptions(nodeHttp2ConnectOptions);
			}
			const { requestTimeout: configRequestTimeout, disableConcurrentStreams } = this.config;
			const useIsolatedSession = disableConcurrentStreams || isEventStream;
			const effectiveRequestTimeout = requestTimeout ?? configRequestTimeout;
			return new Promise((_resolve, _reject) => {
				let fulfilled = false;
				let writeRequestBodyPromise = void 0;
				const resolve = async (arg) => {
					await writeRequestBodyPromise;
					_resolve(arg);
				};
				const reject = async (arg) => {
					await writeRequestBodyPromise;
					_reject(arg);
				};
				if (abortSignal?.aborted) {
					fulfilled = true;
					reject(buildAbortError(abortSignal));
					return;
				}
				const { hostname, method, port, protocol, query } = request;
				let auth = "";
				if (request.username != null || request.password != null) auth = `${request.username ?? ""}:${request.password ?? ""}@`;
				const authority = `${protocol}//${auth}${hostname}${port ? `:${port}` : ""}`;
				const requestContext = { destination: new URL(authority) };
				const connectConfig = {
					requestTimeout: this.config?.sessionTimeout,
					isEventStream
				};
				const ref = useIsolatedSession ? this.connectionManager.createIsolatedSession(requestContext, connectConfig) : this.connectionManager.lease(requestContext, connectConfig);
				const session = ref.deref();
				const rejectWithDestroy = (err) => {
					if (useIsolatedSession) ref.destroy();
					fulfilled = true;
					reject(err);
				};
				const queryString = query ? protocols.buildQueryString(query) : "";
				let path = request.path;
				if (queryString) path += `?${queryString}`;
				if (request.fragment) path += `#${request.fragment}`;
				const clientHttp2Stream = session.request({
					...request.headers,
					[http2.constants.HTTP2_HEADER_PATH]: path,
					[http2.constants.HTTP2_HEADER_METHOD]: method
				});
				if (effectiveRequestTimeout) clientHttp2Stream.setTimeout(effectiveRequestTimeout, () => {
					clientHttp2Stream.close();
					const timeoutError = /* @__PURE__ */ new Error(`Stream timed out because of no activity for ${effectiveRequestTimeout} ms`);
					timeoutError.name = "TimeoutError";
					rejectWithDestroy(timeoutError);
				});
				if (abortSignal) {
					const onAbort = () => {
						clientHttp2Stream.close();
						rejectWithDestroy(buildAbortError(abortSignal));
					};
					if (typeof abortSignal.addEventListener === "function") {
						const signal = abortSignal;
						signal.addEventListener("abort", onAbort, { once: true });
						clientHttp2Stream.once("close", () => signal.removeEventListener("abort", onAbort));
					} else abortSignal.onabort = onAbort;
				}
				clientHttp2Stream.on("frameError", (type, code, id) => {
					rejectWithDestroy(/* @__PURE__ */ new Error(`Frame type id ${type} in stream id ${id} has failed with code ${code}.`));
				});
				clientHttp2Stream.on("error", rejectWithDestroy);
				clientHttp2Stream.on("aborted", () => {
					rejectWithDestroy(/* @__PURE__ */ new Error(`HTTP/2 stream is abnormally aborted in mid-communication with result code ${clientHttp2Stream.rstCode}.`));
				});
				clientHttp2Stream.on("response", (headers) => {
					const httpResponse = new protocols.HttpResponse({
						statusCode: headers[":status"] ?? -1,
						headers: getTransformedHeaders(headers),
						body: clientHttp2Stream
					});
					fulfilled = true;
					resolve({ response: httpResponse });
					if (useIsolatedSession) session.close();
				});
				clientHttp2Stream.on("close", () => {
					if (useIsolatedSession) ref.destroy();
					else this.connectionManager.release(requestContext, ref);
					if (!fulfilled) rejectWithDestroy(/* @__PURE__ */ new Error("Unexpected error: http2 request did not get a response"));
				});
				writeRequestBodyPromise = writeRequestBody(clientHttp2Stream, request, effectiveRequestTimeout);
			});
		}
		updateHttpClientConfig(key, value) {
			this.config = void 0;
			this.configProvider = this.configProvider.then((config) => {
				return {
					...config,
					[key]: value
				};
			});
		}
		httpHandlerConfigs() {
			return this.config ?? {};
		}
	};
	var Collector = class extends node_stream.Writable {
		bufferedBytes = [];
		_write(chunk, encoding, callback) {
			this.bufferedBytes.push(chunk);
			callback();
		}
	};
	const streamCollector = (stream) => {
		if (isReadableStreamInstance(stream)) return collectReadableStream(stream);
		return new Promise((resolve, reject) => {
			const collector = new Collector();
			stream.pipe(collector);
			stream.on("error", (err) => {
				collector.end();
				reject(err);
			});
			collector.on("error", reject);
			collector.on("finish", function() {
				resolve(new Uint8Array(Buffer.concat(this.bufferedBytes)));
			});
		});
	};
	const isReadableStreamInstance = (stream) => typeof ReadableStream === "function" && stream instanceof ReadableStream;
	async function collectReadableStream(stream) {
		const chunks = [];
		const reader = stream.getReader();
		let isDone = false;
		let length = 0;
		while (!isDone) {
			const { done, value } = await reader.read();
			if (value) {
				chunks.push(value);
				length += value.length;
			}
			isDone = done;
		}
		const collected = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			collected.set(chunk, offset);
			offset += chunk.length;
		}
		return collected;
	}
	exports.DEFAULT_REQUEST_TIMEOUT = DEFAULT_REQUEST_TIMEOUT;
	exports.NodeHttp2Handler = NodeHttp2Handler;
	exports.NodeHttpHandler = NodeHttpHandler;
	exports.streamCollector = streamCollector;
}));
//#endregion
export { require_dist_cjs$1 as n, require_dist_cjs as t };
