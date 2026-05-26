import { a as __toCommonJS, n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-HkwdBwDg.js";
import { J as parseRfc7231DateTime, M as normalizeProvider, S as init_config$1, T as NoOpLogger, d as HttpRequest, g as init_serde, t as init_protocols, u as HttpResponse, v as v4, w as init_client$1, x as config_exports } from "./protocols-CO3NMy6S.js";
import { Readable } from "node:stream";
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/emitWarningIfUnsupportedVersion.js
var state, emitWarningIfUnsupportedVersion;
var init_emitWarningIfUnsupportedVersion = __esmMin((() => {
	state = { warningEmitted: false };
	emitWarningIfUnsupportedVersion = (version) => {
		if (version && !state.warningEmitted) {
			if (process.env.AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED === "true") {
				state.warningEmitted = true;
				return;
			}
			const userMajorVersion = parseInt(version.substring(1, version.indexOf(".")));
			const vv = 22;
			if (userMajorVersion < vv) {
				state.warningEmitted = true;
				process.emitWarning(`NodeVersionSupportWarning: The AWS SDK for JavaScript (v3)
versions published after the first week of January 2027
will require node >=${vv}. You are running node ${version}.

To continue receiving updates to AWS services, bug fixes,
and security updates please upgrade to node >=${vv}.

More information can be found at: https://a.co/c895JFp`);
			}
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/longPollMiddleware.js
var longPollMiddleware, longPollMiddlewareOptions, getLongPollPlugin;
var init_longPollMiddleware = __esmMin((() => {
	longPollMiddleware = () => (next, context) => async (args) => {
		context.__retryLongPoll = true;
		return next(args);
	};
	longPollMiddlewareOptions = {
		name: "longPollMiddleware",
		tags: ["RETRY"],
		step: "initialize",
		override: true
	};
	getLongPollPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(longPollMiddleware(), longPollMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/setCredentialFeature.js
function setCredentialFeature(credentials, feature, value) {
	if (!credentials.$source) credentials.$source = {};
	credentials.$source[feature] = value;
	return credentials;
}
var init_setCredentialFeature = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/isStreamingPayload/isStreamingPayload.js
var isStreamingPayload;
var init_isStreamingPayload = __esmMin((() => {
	isStreamingPayload = (request) => request?.body instanceof Readable || typeof ReadableStream !== "undefined" && request?.body instanceof ReadableStream;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/service-error-classification/constants.js
var CLOCK_SKEW_ERROR_CODES, THROTTLING_ERROR_CODES, TRANSIENT_ERROR_CODES, TRANSIENT_ERROR_STATUS_CODES, NODEJS_TIMEOUT_ERROR_CODES, NODEJS_NETWORK_ERROR_CODES;
var init_constants$1 = __esmMin((() => {
	CLOCK_SKEW_ERROR_CODES = [
		"AuthFailure",
		"InvalidSignatureException",
		"RequestExpired",
		"RequestInTheFuture",
		"RequestTimeTooSkewed",
		"SignatureDoesNotMatch"
	];
	THROTTLING_ERROR_CODES = [
		"BandwidthLimitExceeded",
		"EC2ThrottledException",
		"LimitExceededException",
		"PriorRequestNotComplete",
		"ProvisionedThroughputExceededException",
		"RequestLimitExceeded",
		"RequestThrottled",
		"RequestThrottledException",
		"SlowDown",
		"ThrottledException",
		"Throttling",
		"ThrottlingException",
		"TooManyRequestsException",
		"TransactionInProgressException"
	];
	TRANSIENT_ERROR_CODES = [
		"TimeoutError",
		"RequestTimeout",
		"RequestTimeoutException"
	];
	TRANSIENT_ERROR_STATUS_CODES = [
		500,
		502,
		503,
		504
	];
	NODEJS_TIMEOUT_ERROR_CODES = [
		"ECONNRESET",
		"ECONNREFUSED",
		"EPIPE",
		"ETIMEDOUT"
	];
	NODEJS_NETWORK_ERROR_CODES = [
		"EHOSTUNREACH",
		"ENETUNREACH",
		"ENOTFOUND"
	];
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/service-error-classification/service-error-classification.js
function isNodeJsHttp2TransientError(error) {
	return error.code === "ERR_HTTP2_STREAM_ERROR" && error.message.includes("NGHTTP2_REFUSED_STREAM");
}
var isRetryableByTrait, isClockSkewError, isClockSkewCorrectedError, isBrowserNetworkError, isThrottlingError, isTransientError, isServerError;
var init_service_error_classification = __esmMin((() => {
	init_constants$1();
	isRetryableByTrait = (error) => error?.$retryable !== void 0;
	isClockSkewError = (error) => CLOCK_SKEW_ERROR_CODES.includes(error.name);
	isClockSkewCorrectedError = (error) => error.$metadata?.clockSkewCorrected;
	isBrowserNetworkError = (error) => {
		const errorMessages = new Set([
			"Failed to fetch",
			"NetworkError when attempting to fetch resource",
			"The Internet connection appears to be offline",
			"Load failed",
			"Network request failed"
		]);
		if (!(error && error instanceof TypeError)) return false;
		return errorMessages.has(error.message);
	};
	isThrottlingError = (error) => error.$metadata?.httpStatusCode === 429 || THROTTLING_ERROR_CODES.includes(error.name) || error.$retryable?.throttling == true;
	isTransientError = (error, depth = 0) => isRetryableByTrait(error) || isClockSkewCorrectedError(error) || error.name === "InvalidSignatureException" && error.message?.includes("Signature expired") || TRANSIENT_ERROR_CODES.includes(error.name) || NODEJS_TIMEOUT_ERROR_CODES.includes(error?.code || "") || NODEJS_NETWORK_ERROR_CODES.includes(error?.code || "") || TRANSIENT_ERROR_STATUS_CODES.includes(error.$metadata?.httpStatusCode || 0) || isBrowserNetworkError(error) || isNodeJsHttp2TransientError(error) || error.cause !== void 0 && depth <= 10 && isTransientError(error.cause, depth + 1);
	isServerError = (error) => {
		if (error.$metadata?.httpStatusCode !== void 0) {
			const statusCode = error.$metadata.httpStatusCode;
			if (500 <= statusCode && statusCode <= 599 && !isTransientError(error)) return true;
			return false;
		}
		return false;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/constants.js
var MAXIMUM_RETRY_DELAY, INVOCATION_ID_HEADER, REQUEST_HEADER;
var init_constants = __esmMin((() => {
	MAXIMUM_RETRY_DELAY = 20 * 1e3;
	INVOCATION_ID_HEADER = "amz-sdk-invocation-id";
	REQUEST_HEADER = "amz-sdk-request";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/parseRetryAfterHeader.js
function parseRetryAfterHeader(response, logger) {
	if (!HttpResponse.isInstance(response)) return;
	for (const header of Object.keys(response.headers)) {
		const h = header.toLowerCase();
		if (h === "retry-after") {
			const retryAfter = response.headers[header];
			let retryAfterSeconds = NaN;
			if (retryAfter.endsWith("GMT")) try {
				retryAfterSeconds = (parseRfc7231DateTime(retryAfter).getTime() - Date.now()) / 1e3;
			} catch (e) {
				logger?.trace?.("Failed to parse retry-after header");
				logger?.trace?.(e);
			}
			else if (retryAfter.match(/ GMT, ((\d+)|(\d+\.\d+))$/)) retryAfterSeconds = Number(retryAfter.match(/ GMT, ([\d.]+)$/)?.[1]);
			else if (retryAfter.match(/^((\d+)|(\d+\.\d+))$/)) retryAfterSeconds = Number(retryAfter);
			else if (Date.parse(retryAfter) >= Date.now()) retryAfterSeconds = (Date.parse(retryAfter) - Date.now()) / 1e3;
			if (isNaN(retryAfterSeconds)) return;
			return new Date(Date.now() + retryAfterSeconds * 1e3);
		} else if (h === "x-amz-retry-after") {
			const v = response.headers[header];
			const backoffMilliseconds = Number(v);
			if (isNaN(backoffMilliseconds)) {
				logger?.trace?.(`Failed to parse x-amz-retry-after=${v}`);
				return;
			}
			return new Date(Date.now() + backoffMilliseconds);
		}
	}
}
function getRetryAfterHint(response, logger) {
	return parseRetryAfterHeader(response, logger);
}
var init_parseRetryAfterHeader = __esmMin((() => {
	init_protocols();
	init_serde();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/util.js
var asSdkError;
var init_util = __esmMin((() => {
	asSdkError = (error) => {
		if (error instanceof Error) return error;
		if (error instanceof Object) return Object.assign(/* @__PURE__ */ new Error(), error);
		if (typeof error === "string") return new Error(error);
		return /* @__PURE__ */ new Error(`AWS SDK error wrapper for ${error}`);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retryMiddleware.js
function bindRetryMiddleware(isStreamingPayload) {
	return (options) => (next, context) => async (args) => {
		let retryStrategy = await options.retryStrategy();
		const maxAttempts = await options.maxAttempts();
		if (isRetryStrategyV2(retryStrategy)) {
			retryStrategy = retryStrategy;
			let retryToken = await retryStrategy.acquireInitialRetryToken((context["partition_id"] ?? "") + (context.__retryLongPoll ? ":longpoll" : ""));
			let lastError = /* @__PURE__ */ new Error();
			let attempts = 0;
			let totalRetryDelay = 0;
			const { request } = args;
			const isRequest = HttpRequest.isInstance(request);
			if (isRequest) request.headers[INVOCATION_ID_HEADER] = v4();
			while (true) try {
				if (isRequest) request.headers[REQUEST_HEADER] = `attempt=${attempts + 1}; max=${maxAttempts}`;
				const { response, output } = await next(args);
				retryStrategy.recordSuccess(retryToken);
				output.$metadata.attempts = attempts + 1;
				output.$metadata.totalRetryDelay = totalRetryDelay;
				return {
					response,
					output
				};
			} catch (e) {
				const retryErrorInfo = getRetryErrorInfo(e, options.logger);
				lastError = asSdkError(e);
				if (isRequest && isStreamingPayload(request)) {
					(context.logger instanceof NoOpLogger ? console : context.logger)?.warn("An error was encountered in a non-retryable streaming request.");
					throw lastError;
				}
				try {
					retryToken = await retryStrategy.refreshRetryTokenForRetry(retryToken, retryErrorInfo);
				} catch (refreshError) {
					if (typeof refreshError.$backoff === "number") await cooldown(refreshError.$backoff);
					if (!lastError.$metadata) lastError.$metadata = {};
					lastError.$metadata.attempts = attempts + 1;
					lastError.$metadata.totalRetryDelay = totalRetryDelay;
					throw lastError;
				}
				attempts = retryToken.getRetryCount();
				const delay = retryToken.getRetryDelay();
				totalRetryDelay += delay;
				await cooldown(delay);
			}
		} else {
			retryStrategy = retryStrategy;
			if (retryStrategy?.mode) context.userAgent = [...context.userAgent || [], ["cfg/retry-mode", retryStrategy.mode]];
			return retryStrategy.retry(next, args);
		}
	};
}
function bindGetRetryPlugin(isStreamingPayload) {
	const retryMiddleware = bindRetryMiddleware(isStreamingPayload);
	return (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(retryMiddleware(options), retryMiddlewareOptions);
	} });
}
var cooldown, isRetryStrategyV2, getRetryErrorInfo, getRetryErrorType, retryMiddlewareOptions;
var init_retryMiddleware = __esmMin((() => {
	init_client$1();
	init_protocols();
	init_serde();
	init_service_error_classification();
	init_constants();
	init_parseRetryAfterHeader();
	init_util();
	cooldown = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	isRetryStrategyV2 = (retryStrategy) => typeof retryStrategy.acquireInitialRetryToken !== "undefined" && typeof retryStrategy.refreshRetryTokenForRetry !== "undefined" && typeof retryStrategy.recordSuccess !== "undefined";
	getRetryErrorInfo = (error, logger) => {
		const errorInfo = {
			error,
			errorType: getRetryErrorType(error)
		};
		const retryAfterHint = parseRetryAfterHeader(error.$response, logger);
		if (retryAfterHint) errorInfo.retryAfterHint = retryAfterHint;
		return errorInfo;
	};
	getRetryErrorType = (error) => {
		if (isThrottlingError(error)) return "THROTTLING";
		if (isTransientError(error)) return "TRANSIENT";
		if (isServerError(error)) return "SERVER_ERROR";
		return "CLIENT_ERROR";
	};
	retryMiddlewareOptions = {
		name: "retryMiddleware",
		tags: ["RETRY"],
		step: "finalizeRequest",
		priority: "high",
		override: true
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/DefaultRateLimiter.js
var DefaultRateLimiter;
var init_DefaultRateLimiter = __esmMin((() => {
	init_service_error_classification();
	DefaultRateLimiter = class DefaultRateLimiter {
		static setTimeoutFn = setTimeout;
		beta;
		minCapacity;
		minFillRate;
		scaleConstant;
		smooth;
		enabled = false;
		availableTokens = 0;
		lastMaxRate = 0;
		measuredTxRate = 0;
		requestCount = 0;
		fillRate;
		lastThrottleTime;
		lastTimestamp = 0;
		lastTxRateBucket;
		maxCapacity;
		timeWindow = 0;
		constructor(options) {
			this.beta = options?.beta ?? .7;
			this.minCapacity = options?.minCapacity ?? 1;
			this.minFillRate = options?.minFillRate ?? .5;
			this.scaleConstant = options?.scaleConstant ?? .4;
			this.smooth = options?.smooth ?? .8;
			this.lastThrottleTime = this.getCurrentTimeInSeconds();
			this.lastTxRateBucket = Math.floor(this.getCurrentTimeInSeconds());
			this.fillRate = this.minFillRate;
			this.maxCapacity = this.minCapacity;
		}
		async getSendToken() {
			return this.acquireTokenBucket(1);
		}
		updateClientSendingRate(response) {
			let calculatedRate;
			this.updateMeasuredRate();
			const retryErrorInfo = response;
			if (retryErrorInfo?.errorType === "THROTTLING" || isThrottlingError(retryErrorInfo?.error ?? response)) {
				const rateToUse = !this.enabled ? this.measuredTxRate : Math.min(this.measuredTxRate, this.fillRate);
				this.lastMaxRate = rateToUse;
				this.calculateTimeWindow();
				this.lastThrottleTime = this.getCurrentTimeInSeconds();
				calculatedRate = this.cubicThrottle(rateToUse);
				this.enableTokenBucket();
			} else {
				this.calculateTimeWindow();
				calculatedRate = this.cubicSuccess(this.getCurrentTimeInSeconds());
			}
			const newRate = Math.min(calculatedRate, 2 * this.measuredTxRate);
			this.updateTokenBucketRate(newRate);
		}
		getCurrentTimeInSeconds() {
			return Date.now() / 1e3;
		}
		async acquireTokenBucket(amount) {
			if (!this.enabled) return;
			this.refillTokenBucket();
			while (amount > this.availableTokens) {
				const delay = (amount - this.availableTokens) / this.fillRate * 1e3;
				await new Promise((resolve) => DefaultRateLimiter.setTimeoutFn(resolve, delay));
				this.refillTokenBucket();
			}
			this.availableTokens = this.availableTokens - amount;
		}
		refillTokenBucket() {
			const timestamp = this.getCurrentTimeInSeconds();
			if (!this.lastTimestamp) {
				this.lastTimestamp = timestamp;
				return;
			}
			const fillAmount = (timestamp - this.lastTimestamp) * this.fillRate;
			this.availableTokens = Math.min(this.maxCapacity, this.availableTokens + fillAmount);
			this.lastTimestamp = timestamp;
		}
		calculateTimeWindow() {
			this.timeWindow = this.getPrecise(Math.pow(this.lastMaxRate * (1 - this.beta) / this.scaleConstant, 1 / 3));
		}
		cubicThrottle(rateToUse) {
			return this.getPrecise(rateToUse * this.beta);
		}
		cubicSuccess(timestamp) {
			return this.getPrecise(this.scaleConstant * Math.pow(timestamp - this.lastThrottleTime - this.timeWindow, 3) + this.lastMaxRate);
		}
		enableTokenBucket() {
			this.enabled = true;
		}
		updateTokenBucketRate(newRate) {
			this.refillTokenBucket();
			this.fillRate = Math.max(newRate, this.minFillRate);
			this.maxCapacity = Math.max(newRate, this.minCapacity);
			this.availableTokens = Math.min(this.availableTokens, this.maxCapacity);
		}
		updateMeasuredRate() {
			const t = this.getCurrentTimeInSeconds();
			const timeBucket = Math.floor(t * 2) / 2;
			this.requestCount++;
			if (timeBucket > this.lastTxRateBucket) {
				const currentRate = this.requestCount / (timeBucket - this.lastTxRateBucket);
				this.measuredTxRate = this.getPrecise(currentRate * this.smooth + this.measuredTxRate * (1 - this.smooth));
				this.requestCount = 0;
				this.lastTxRateBucket = timeBucket;
			}
		}
		getPrecise(num) {
			return parseFloat(num.toFixed(8));
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/retries-2026-config.js
var Retry$1;
var init_retries_2026_config = __esmMin((() => {
	Retry$1 = class Retry$1 {
		static v2026 = typeof process !== "undefined" && process.env?.SMITHY_NEW_RETRIES_2026 === "true";
		static delay() {
			return Retry$1.v2026 ? 50 : 100;
		}
		static throttlingDelay() {
			return Retry$1.v2026 ? 1e3 : 500;
		}
		static cost() {
			return Retry$1.v2026 ? 14 : 5;
		}
		static throttlingCost() {
			return Retry$1.v2026 ? 5 : 10;
		}
		static modifiedCostType() {
			return Retry$1.v2026 ? "THROTTLING" : "TRANSIENT";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/DefaultRetryBackoffStrategy.js
var DefaultRetryBackoffStrategy;
var init_DefaultRetryBackoffStrategy = __esmMin((() => {
	init_constants();
	init_retries_2026_config();
	DefaultRetryBackoffStrategy = class {
		x = Retry$1.delay();
		computeNextBackoffDelay(i) {
			const t_i = Math.random() * Math.min(this.x * 2 ** i, MAXIMUM_RETRY_DELAY);
			return Math.floor(t_i);
		}
		setDelayBase(delay) {
			this.x = delay;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/DefaultRetryToken.js
var DefaultRetryToken;
var init_DefaultRetryToken = __esmMin((() => {
	init_constants();
	DefaultRetryToken = class {
		delay;
		count;
		cost;
		longPoll;
		constructor(delay, count, cost, longPoll) {
			this.delay = delay;
			this.count = count;
			this.cost = cost;
			this.longPoll = longPoll;
		}
		getRetryCount() {
			return this.count;
		}
		getRetryDelay() {
			return Math.min(MAXIMUM_RETRY_DELAY, this.delay);
		}
		getRetryCost() {
			return this.cost;
		}
		isLongPoll() {
			return this.longPoll;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/config.js
var RETRY_MODES, DEFAULT_RETRY_MODE;
var init_config = __esmMin((() => {
	(function(RETRY_MODES) {
		RETRY_MODES["STANDARD"] = "standard";
		RETRY_MODES["ADAPTIVE"] = "adaptive";
	})(RETRY_MODES || (RETRY_MODES = {}));
	DEFAULT_RETRY_MODE = RETRY_MODES.STANDARD;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/StandardRetryStrategy.js
var refusal, StandardRetryStrategy$1;
var init_StandardRetryStrategy$1 = __esmMin((() => {
	init_DefaultRetryBackoffStrategy();
	init_DefaultRetryToken();
	init_config();
	init_constants();
	init_retries_2026_config();
	refusal = {
		incompatible: 1,
		attempts: 2,
		capacity: 3
	};
	StandardRetryStrategy$1 = class {
		mode = RETRY_MODES.STANDARD;
		capacity = 500;
		retryBackoffStrategy;
		maxAttemptsProvider;
		baseDelay;
		constructor(arg1) {
			if (typeof arg1 === "number") this.maxAttemptsProvider = async () => arg1;
			else if (typeof arg1 === "function") this.maxAttemptsProvider = arg1;
			else if (arg1 && typeof arg1 === "object") {
				this.maxAttemptsProvider = async () => arg1.maxAttempts;
				this.baseDelay = arg1.baseDelay;
				this.retryBackoffStrategy = arg1.backoff;
			}
			this.maxAttemptsProvider ??= async () => 3;
			this.baseDelay ??= Retry$1.delay();
			this.retryBackoffStrategy ??= new DefaultRetryBackoffStrategy();
		}
		async acquireInitialRetryToken(retryTokenScope) {
			return new DefaultRetryToken(Retry$1.delay(), 0, void 0, Retry$1.v2026 && retryTokenScope.includes(":longpoll"));
		}
		async refreshRetryTokenForRetry(token, errorInfo) {
			const maxAttempts = await this.getMaxAttempts();
			const retryCode = this.retryCode(token, errorInfo, maxAttempts);
			const shouldRetry = retryCode === 0;
			const isLongPoll = token.isLongPoll?.();
			if (shouldRetry || isLongPoll) {
				const errorType = errorInfo.errorType;
				this.retryBackoffStrategy.setDelayBase(errorType === "THROTTLING" ? Retry$1.throttlingDelay() : this.baseDelay);
				const delayFromErrorType = this.retryBackoffStrategy.computeNextBackoffDelay(token.getRetryCount());
				let retryDelay = delayFromErrorType;
				if (errorInfo.retryAfterHint instanceof Date) retryDelay = Math.max(delayFromErrorType, Math.min(errorInfo.retryAfterHint.getTime() - Date.now(), delayFromErrorType + 5e3));
				if (!shouldRetry) throw Object.assign(/* @__PURE__ */ new Error("No retry token available"), { $backoff: Retry$1.v2026 && retryCode === refusal.capacity && isLongPoll ? retryDelay : 0 });
				else {
					const capacityCost = this.getCapacityCost(errorType);
					this.capacity -= capacityCost;
					return new DefaultRetryToken(retryDelay, token.getRetryCount() + 1, capacityCost, token.isLongPoll?.() ?? false);
				}
			}
			throw new Error("No retry token available");
		}
		recordSuccess(token) {
			this.capacity = Math.min(500, this.capacity + (token.getRetryCost() ?? 1));
		}
		getCapacity() {
			return this.capacity;
		}
		async maxAttempts() {
			return this.maxAttemptsProvider();
		}
		async getMaxAttempts() {
			try {
				return await this.maxAttemptsProvider();
			} catch (error) {
				console.warn(`Max attempts provider could not resolve. Using default of 3`);
				return 3;
			}
		}
		retryCode(tokenToRenew, errorInfo, maxAttempts) {
			const attempts = tokenToRenew.getRetryCount() + 1;
			const retryableStatus = this.isRetryableError(errorInfo.errorType) ? 0 : refusal.incompatible;
			const attemptStatus = attempts < maxAttempts ? 0 : refusal.attempts;
			const capacityStatus = this.capacity >= this.getCapacityCost(errorInfo.errorType) ? 0 : refusal.capacity;
			return retryableStatus || attemptStatus || capacityStatus;
		}
		getCapacityCost(errorType) {
			return errorType === Retry$1.modifiedCostType() ? Retry$1.throttlingCost() : Retry$1.cost();
		}
		isRetryableError(errorType) {
			return errorType === "THROTTLING" || errorType === "TRANSIENT";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/AdaptiveRetryStrategy.js
var AdaptiveRetryStrategy$1;
var init_AdaptiveRetryStrategy$1 = __esmMin((() => {
	init_DefaultRateLimiter();
	init_StandardRetryStrategy$1();
	init_config();
	AdaptiveRetryStrategy$1 = class {
		mode = RETRY_MODES.ADAPTIVE;
		rateLimiter;
		standardRetryStrategy;
		constructor(maxAttemptsProvider, options) {
			const { rateLimiter } = options ?? {};
			this.rateLimiter = rateLimiter ?? new DefaultRateLimiter();
			this.standardRetryStrategy = options ? new StandardRetryStrategy$1({
				maxAttempts: typeof maxAttemptsProvider === "number" ? maxAttemptsProvider : 3,
				...options
			}) : new StandardRetryStrategy$1(maxAttemptsProvider);
		}
		async acquireInitialRetryToken(retryTokenScope) {
			const token = await this.standardRetryStrategy.acquireInitialRetryToken(retryTokenScope);
			await this.rateLimiter.getSendToken();
			return token;
		}
		async refreshRetryTokenForRetry(tokenToRenew, errorInfo) {
			this.rateLimiter.updateClientSendingRate(errorInfo);
			const token = await this.standardRetryStrategy.refreshRetryTokenForRetry(tokenToRenew, errorInfo);
			await this.rateLimiter.getSendToken();
			return token;
		}
		recordSuccess(token) {
			this.rateLimiter.updateClientSendingRate({});
			this.standardRetryStrategy.recordSuccess(token);
		}
		async maxAttemptsProvider() {
			return this.standardRetryStrategy.maxAttempts();
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/ConfiguredRetryStrategy.js
var ConfiguredRetryStrategy;
var init_ConfiguredRetryStrategy = __esmMin((() => {
	init_StandardRetryStrategy$1();
	init_retries_2026_config();
	ConfiguredRetryStrategy = class extends StandardRetryStrategy$1 {
		computeNextBackoffDelay;
		constructor(maxAttempts, computeNextBackoffDelay = Retry$1.delay()) {
			super(typeof maxAttempts === "function" ? maxAttempts : async () => maxAttempts);
			if (typeof computeNextBackoffDelay === "number") this.computeNextBackoffDelay = () => computeNextBackoffDelay;
			else this.computeNextBackoffDelay = computeNextBackoffDelay;
		}
		async refreshRetryTokenForRetry(tokenToRenew, errorInfo) {
			const token = await super.refreshRetryTokenForRetry(tokenToRenew, errorInfo);
			token.getRetryDelay = () => this.computeNextBackoffDelay(token.getRetryCount());
			return token;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retry-pre-sra-deprecated/defaultRetryQuota.js
var getDefaultRetryQuota;
var init_defaultRetryQuota = __esmMin((() => {
	init_constants();
	getDefaultRetryQuota = (initialRetryTokens, options) => {
		const MAX_CAPACITY = initialRetryTokens;
		const noRetryIncrement = options?.noRetryIncrement ?? 1;
		const retryCost = options?.retryCost ?? 5;
		const timeoutRetryCost = options?.timeoutRetryCost ?? 10;
		let availableCapacity = initialRetryTokens;
		const getCapacityAmount = (error) => error.name === "TimeoutError" ? timeoutRetryCost : retryCost;
		const hasRetryTokens = (error) => getCapacityAmount(error) <= availableCapacity;
		const retrieveRetryTokens = (error) => {
			if (!hasRetryTokens(error)) throw new Error("No retry token available");
			const capacityAmount = getCapacityAmount(error);
			availableCapacity -= capacityAmount;
			return capacityAmount;
		};
		const releaseRetryTokens = (capacityReleaseAmount) => {
			availableCapacity += capacityReleaseAmount ?? noRetryIncrement;
			availableCapacity = Math.min(availableCapacity, MAX_CAPACITY);
		};
		return Object.freeze({
			hasRetryTokens,
			retrieveRetryTokens,
			releaseRetryTokens
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retry-pre-sra-deprecated/delayDecider.js
var defaultDelayDecider;
var init_delayDecider = __esmMin((() => {
	init_constants();
	defaultDelayDecider = (delayBase, attempts) => Math.floor(Math.min(MAXIMUM_RETRY_DELAY, Math.random() * 2 ** attempts * delayBase));
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retry-pre-sra-deprecated/retryDecider.js
var defaultRetryDecider;
var init_retryDecider = __esmMin((() => {
	init_service_error_classification();
	defaultRetryDecider = (error) => {
		if (!error) return false;
		return isRetryableByTrait(error) || isClockSkewError(error) || isThrottlingError(error) || isTransientError(error);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retry-pre-sra-deprecated/StandardRetryStrategy.js
var StandardRetryStrategy, getDelayFromRetryAfterHeader;
var init_StandardRetryStrategy = __esmMin((() => {
	init_protocols();
	init_serde();
	init_service_error_classification();
	init_config();
	init_constants();
	init_util();
	init_defaultRetryQuota();
	init_delayDecider();
	init_retryDecider();
	StandardRetryStrategy = class {
		maxAttemptsProvider;
		retryDecider;
		delayDecider;
		retryQuota;
		mode = RETRY_MODES.STANDARD;
		constructor(maxAttemptsProvider, options) {
			this.maxAttemptsProvider = maxAttemptsProvider;
			this.retryDecider = options?.retryDecider ?? defaultRetryDecider;
			this.delayDecider = options?.delayDecider ?? defaultDelayDecider;
			this.retryQuota = options?.retryQuota ?? getDefaultRetryQuota(500);
		}
		shouldRetry(error, attempts, maxAttempts) {
			return attempts < maxAttempts && this.retryDecider(error) && this.retryQuota.hasRetryTokens(error);
		}
		async getMaxAttempts() {
			let maxAttempts;
			try {
				maxAttempts = await this.maxAttemptsProvider();
			} catch (error) {
				maxAttempts = 3;
			}
			return maxAttempts;
		}
		async retry(next, args, options) {
			let retryTokenAmount;
			let attempts = 0;
			let totalDelay = 0;
			const maxAttempts = await this.getMaxAttempts();
			const { request } = args;
			if (HttpRequest.isInstance(request)) request.headers[INVOCATION_ID_HEADER] = v4();
			while (true) try {
				if (HttpRequest.isInstance(request)) request.headers[REQUEST_HEADER] = `attempt=${attempts + 1}; max=${maxAttempts}`;
				if (options?.beforeRequest) await options.beforeRequest();
				const { response, output } = await next(args);
				if (options?.afterRequest) options.afterRequest(response);
				this.retryQuota.releaseRetryTokens(retryTokenAmount);
				output.$metadata.attempts = attempts + 1;
				output.$metadata.totalRetryDelay = totalDelay;
				return {
					response,
					output
				};
			} catch (e) {
				const err = asSdkError(e);
				attempts++;
				if (this.shouldRetry(err, attempts, maxAttempts)) {
					retryTokenAmount = this.retryQuota.retrieveRetryTokens(err);
					const delayFromDecider = this.delayDecider(isThrottlingError(err) ? 500 : 100, attempts);
					const delayFromResponse = getDelayFromRetryAfterHeader(err.$response);
					const delay = Math.max(delayFromResponse || 0, delayFromDecider);
					totalDelay += delay;
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
				if (!err.$metadata) err.$metadata = {};
				err.$metadata.attempts = attempts;
				err.$metadata.totalRetryDelay = totalDelay;
				throw err;
			}
		}
	};
	getDelayFromRetryAfterHeader = (response) => {
		if (!HttpResponse.isInstance(response)) return;
		const retryAfterHeaderName = Object.keys(response.headers).find((key) => key.toLowerCase() === "retry-after");
		if (!retryAfterHeaderName) return;
		const retryAfter = response.headers[retryAfterHeaderName];
		const retryAfterSeconds = Number(retryAfter);
		if (!Number.isNaN(retryAfterSeconds)) return retryAfterSeconds * 1e3;
		return new Date(retryAfter).getTime() - Date.now();
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/retry-pre-sra-deprecated/AdaptiveRetryStrategy.js
var AdaptiveRetryStrategy;
var init_AdaptiveRetryStrategy = __esmMin((() => {
	init_DefaultRateLimiter();
	init_config();
	init_StandardRetryStrategy();
	AdaptiveRetryStrategy = class extends StandardRetryStrategy {
		rateLimiter;
		constructor(maxAttemptsProvider, options) {
			const { rateLimiter, ...superOptions } = options ?? {};
			super(maxAttemptsProvider, superOptions);
			this.rateLimiter = rateLimiter ?? new DefaultRateLimiter();
			this.mode = RETRY_MODES.ADAPTIVE;
		}
		async retry(next, args) {
			return super.retry(next, args, {
				beforeRequest: async () => {
					return this.rateLimiter.getSendToken();
				},
				afterRequest: (response) => {
					this.rateLimiter.updateClientSendingRate(response);
				}
			});
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/configurations.js
var ENV_MAX_ATTEMPTS, CONFIG_MAX_ATTEMPTS, NODE_MAX_ATTEMPT_CONFIG_OPTIONS, resolveRetryConfig, ENV_RETRY_MODE, CONFIG_RETRY_MODE, NODE_RETRY_MODE_CONFIG_OPTIONS;
var init_configurations = __esmMin((() => {
	init_client$1();
	init_AdaptiveRetryStrategy$1();
	init_StandardRetryStrategy$1();
	init_config();
	ENV_MAX_ATTEMPTS = "AWS_MAX_ATTEMPTS";
	CONFIG_MAX_ATTEMPTS = "max_attempts";
	NODE_MAX_ATTEMPT_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => {
			const value = env[ENV_MAX_ATTEMPTS];
			if (!value) return void 0;
			const maxAttempt = parseInt(value);
			if (Number.isNaN(maxAttempt)) throw new Error(`Environment variable ${ENV_MAX_ATTEMPTS} mast be a number, got "${value}"`);
			return maxAttempt;
		},
		configFileSelector: (profile) => {
			const value = profile[CONFIG_MAX_ATTEMPTS];
			if (!value) return void 0;
			const maxAttempt = parseInt(value);
			if (Number.isNaN(maxAttempt)) throw new Error(`Shared config file entry ${CONFIG_MAX_ATTEMPTS} mast be a number, got "${value}"`);
			return maxAttempt;
		},
		default: 3
	};
	resolveRetryConfig = (input) => {
		const { retryStrategy, retryMode } = input;
		const maxAttempts = normalizeProvider(input.maxAttempts ?? 3);
		let controller = retryStrategy ? Promise.resolve(retryStrategy) : void 0;
		const getDefault = async () => await normalizeProvider(retryMode)() === RETRY_MODES.ADAPTIVE ? new AdaptiveRetryStrategy$1(maxAttempts) : new StandardRetryStrategy$1(maxAttempts);
		return Object.assign(input, {
			maxAttempts,
			retryStrategy: () => controller ??= getDefault()
		});
	};
	ENV_RETRY_MODE = "AWS_RETRY_MODE";
	CONFIG_RETRY_MODE = "retry_mode";
	NODE_RETRY_MODE_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => env[ENV_RETRY_MODE],
		configFileSelector: (profile) => profile[CONFIG_RETRY_MODE],
		default: DEFAULT_RETRY_MODE
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/middleware-retry/omitRetryHeadersMiddleware.js
var omitRetryHeadersMiddleware, omitRetryHeadersMiddlewareOptions, getOmitRetryHeadersPlugin;
var init_omitRetryHeadersMiddleware = __esmMin((() => {
	init_protocols();
	init_constants();
	omitRetryHeadersMiddleware = () => (next) => async (args) => {
		const { request } = args;
		if (HttpRequest.isInstance(request)) {
			delete request.headers[INVOCATION_ID_HEADER];
			delete request.headers[REQUEST_HEADER];
		}
		return next(args);
	};
	omitRetryHeadersMiddlewareOptions = {
		name: "omitRetryHeadersMiddleware",
		tags: [
			"RETRY",
			"HEADERS",
			"OMIT_RETRY_HEADERS"
		],
		relation: "before",
		toMiddleware: "awsAuthMiddleware",
		override: true
	};
	getOmitRetryHeadersPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(omitRetryHeadersMiddleware(), omitRetryHeadersMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/index.js
var retry_exports = /* @__PURE__ */ __exportAll({
	AdaptiveRetryStrategy: () => AdaptiveRetryStrategy$1,
	CONFIG_MAX_ATTEMPTS: () => CONFIG_MAX_ATTEMPTS,
	CONFIG_RETRY_MODE: () => CONFIG_RETRY_MODE,
	ConfiguredRetryStrategy: () => ConfiguredRetryStrategy,
	DEFAULT_MAX_ATTEMPTS: () => 3,
	DEFAULT_RETRY_DELAY_BASE: () => 100,
	DEFAULT_RETRY_MODE: () => DEFAULT_RETRY_MODE,
	DefaultRateLimiter: () => DefaultRateLimiter,
	DeprecatedAdaptiveRetryStrategy: () => AdaptiveRetryStrategy,
	DeprecatedStandardRetryStrategy: () => StandardRetryStrategy,
	ENV_MAX_ATTEMPTS: () => ENV_MAX_ATTEMPTS,
	ENV_RETRY_MODE: () => ENV_RETRY_MODE,
	INITIAL_RETRY_TOKENS: () => 500,
	INVOCATION_ID_HEADER: () => INVOCATION_ID_HEADER,
	MAXIMUM_RETRY_DELAY: () => MAXIMUM_RETRY_DELAY,
	NODE_MAX_ATTEMPT_CONFIG_OPTIONS: () => NODE_MAX_ATTEMPT_CONFIG_OPTIONS,
	NODE_RETRY_MODE_CONFIG_OPTIONS: () => NODE_RETRY_MODE_CONFIG_OPTIONS,
	NO_RETRY_INCREMENT: () => 1,
	REQUEST_HEADER: () => REQUEST_HEADER,
	RETRY_COST: () => 5,
	RETRY_MODES: () => RETRY_MODES,
	Retry: () => Retry$1,
	StandardRetryStrategy: () => StandardRetryStrategy$1,
	THROTTLING_RETRY_DELAY_BASE: () => 500,
	TIMEOUT_RETRY_COST: () => 10,
	defaultDelayDecider: () => defaultDelayDecider,
	defaultRetryDecider: () => defaultRetryDecider,
	getOmitRetryHeadersPlugin: () => getOmitRetryHeadersPlugin,
	getRetryAfterHint: () => getRetryAfterHint,
	getRetryPlugin: () => getRetryPlugin,
	isBrowserNetworkError: () => isBrowserNetworkError,
	isClockSkewCorrectedError: () => isClockSkewCorrectedError,
	isClockSkewError: () => isClockSkewError,
	isNodeJsHttp2TransientError: () => isNodeJsHttp2TransientError,
	isRetryableByTrait: () => isRetryableByTrait,
	isServerError: () => isServerError,
	isThrottlingError: () => isThrottlingError,
	isTransientError: () => isTransientError,
	omitRetryHeadersMiddleware: () => omitRetryHeadersMiddleware,
	omitRetryHeadersMiddlewareOptions: () => omitRetryHeadersMiddlewareOptions,
	resolveRetryConfig: () => resolveRetryConfig,
	retryMiddleware: () => retryMiddleware,
	retryMiddlewareOptions: () => retryMiddlewareOptions
});
var retryMiddleware, getRetryPlugin;
var init_retry = __esmMin((() => {
	init_isStreamingPayload();
	init_retryMiddleware();
	init_service_error_classification();
	init_AdaptiveRetryStrategy$1();
	init_ConfiguredRetryStrategy();
	init_DefaultRateLimiter();
	init_StandardRetryStrategy$1();
	init_config();
	init_constants();
	init_retries_2026_config();
	init_AdaptiveRetryStrategy();
	init_StandardRetryStrategy();
	init_delayDecider();
	init_retryDecider();
	init_configurations();
	init_omitRetryHeadersMiddleware();
	init_parseRetryAfterHeader();
	retryMiddleware = bindRetryMiddleware(isStreamingPayload);
	getRetryPlugin = bindGetRetryPlugin(isStreamingPayload);
}));
//#endregion
//#region node_modules/@smithy/util-retry/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TIMEOUT_RETRY_COST = exports.THROTTLING_RETRY_DELAY_BASE = exports.Retry = exports.RETRY_MODES = exports.RETRY_COST = exports.NO_RETRY_INCREMENT = exports.REQUEST_HEADER = exports.MAXIMUM_RETRY_DELAY = exports.INVOCATION_ID_HEADER = exports.INITIAL_RETRY_TOKENS = exports.DEFAULT_RETRY_MODE = exports.DEFAULT_RETRY_DELAY_BASE = exports.DEFAULT_MAX_ATTEMPTS = exports.StandardRetryStrategy = exports.DefaultRateLimiter = exports.ConfiguredRetryStrategy = exports.AdaptiveRetryStrategy = void 0;
	var retry_1 = (init_retry(), __toCommonJS(retry_exports));
	Object.defineProperty(exports, "AdaptiveRetryStrategy", {
		enumerable: true,
		get: function() {
			return retry_1.AdaptiveRetryStrategy;
		}
	});
	Object.defineProperty(exports, "ConfiguredRetryStrategy", {
		enumerable: true,
		get: function() {
			return retry_1.ConfiguredRetryStrategy;
		}
	});
	Object.defineProperty(exports, "DefaultRateLimiter", {
		enumerable: true,
		get: function() {
			return retry_1.DefaultRateLimiter;
		}
	});
	Object.defineProperty(exports, "StandardRetryStrategy", {
		enumerable: true,
		get: function() {
			return retry_1.StandardRetryStrategy;
		}
	});
	Object.defineProperty(exports, "DEFAULT_MAX_ATTEMPTS", {
		enumerable: true,
		get: function() {
			return retry_1.DEFAULT_MAX_ATTEMPTS;
		}
	});
	Object.defineProperty(exports, "DEFAULT_RETRY_DELAY_BASE", {
		enumerable: true,
		get: function() {
			return retry_1.DEFAULT_RETRY_DELAY_BASE;
		}
	});
	Object.defineProperty(exports, "DEFAULT_RETRY_MODE", {
		enumerable: true,
		get: function() {
			return retry_1.DEFAULT_RETRY_MODE;
		}
	});
	Object.defineProperty(exports, "INITIAL_RETRY_TOKENS", {
		enumerable: true,
		get: function() {
			return retry_1.INITIAL_RETRY_TOKENS;
		}
	});
	Object.defineProperty(exports, "INVOCATION_ID_HEADER", {
		enumerable: true,
		get: function() {
			return retry_1.INVOCATION_ID_HEADER;
		}
	});
	Object.defineProperty(exports, "MAXIMUM_RETRY_DELAY", {
		enumerable: true,
		get: function() {
			return retry_1.MAXIMUM_RETRY_DELAY;
		}
	});
	Object.defineProperty(exports, "REQUEST_HEADER", {
		enumerable: true,
		get: function() {
			return retry_1.REQUEST_HEADER;
		}
	});
	Object.defineProperty(exports, "NO_RETRY_INCREMENT", {
		enumerable: true,
		get: function() {
			return retry_1.NO_RETRY_INCREMENT;
		}
	});
	Object.defineProperty(exports, "RETRY_COST", {
		enumerable: true,
		get: function() {
			return retry_1.RETRY_COST;
		}
	});
	Object.defineProperty(exports, "RETRY_MODES", {
		enumerable: true,
		get: function() {
			return retry_1.RETRY_MODES;
		}
	});
	Object.defineProperty(exports, "Retry", {
		enumerable: true,
		get: function() {
			return retry_1.Retry;
		}
	});
	Object.defineProperty(exports, "THROTTLING_RETRY_DELAY_BASE", {
		enumerable: true,
		get: function() {
			return retry_1.THROTTLING_RETRY_DELAY_BASE;
		}
	});
	Object.defineProperty(exports, "TIMEOUT_RETRY_COST", {
		enumerable: true,
		get: function() {
			return retry_1.TIMEOUT_RETRY_COST;
		}
	});
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/setFeature.js
function setFeature(context, feature, value) {
	if (!context.__aws_sdk_context) context.__aws_sdk_context = { features: {} };
	else if (!context.__aws_sdk_context.features) context.__aws_sdk_context.features = {};
	context.__aws_sdk_context.features[feature] = value;
}
var import_dist_cjs;
var init_setFeature = __esmMin((() => {
	import_dist_cjs = require_dist_cjs$1();
	import_dist_cjs.Retry.v2026 ||= typeof process === "object" && process.env?.AWS_NEW_RETRIES_2026 === "true";
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/setTokenFeature.js
function setTokenFeature(token, feature, value) {
	if (!token.$source) token.$source = {};
	token.$source[feature] = value;
	return token;
}
var init_setTokenFeature = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/index.js
var client_exports = /* @__PURE__ */ __exportAll({
	emitWarningIfUnsupportedVersion: () => emitWarningIfUnsupportedVersion,
	getLongPollPlugin: () => getLongPollPlugin,
	setCredentialFeature: () => setCredentialFeature,
	setFeature: () => setFeature,
	setTokenFeature: () => setTokenFeature,
	state: () => state
});
var init_client = __esmMin((() => {
	init_emitWarningIfUnsupportedVersion();
	init_longPollMiddleware();
	init_setCredentialFeature();
	init_setFeature();
	init_setTokenFeature();
}));
//#endregion
//#region node_modules/@smithy/property-provider/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.memoize = exports.fromStatic = exports.chain = exports.TokenProviderError = exports.CredentialsProviderError = exports.ProviderError = void 0;
	var config_1 = (init_config$1(), __toCommonJS(config_exports));
	Object.defineProperty(exports, "ProviderError", {
		enumerable: true,
		get: function() {
			return config_1.ProviderError;
		}
	});
	Object.defineProperty(exports, "CredentialsProviderError", {
		enumerable: true,
		get: function() {
			return config_1.CredentialsProviderError;
		}
	});
	Object.defineProperty(exports, "TokenProviderError", {
		enumerable: true,
		get: function() {
			return config_1.TokenProviderError;
		}
	});
	Object.defineProperty(exports, "chain", {
		enumerable: true,
		get: function() {
			return config_1.chain;
		}
	});
	Object.defineProperty(exports, "fromStatic", {
		enumerable: true,
		get: function() {
			return config_1.fromValue;
		}
	});
	Object.defineProperty(exports, "memoize", {
		enumerable: true,
		get: function() {
			return config_1.memoize;
		}
	});
}));
//#endregion
export { init_retry as a, emitWarningIfUnsupportedVersion as c, require_dist_cjs$1 as i, client_exports as n, retry_exports as o, init_client as r, setCredentialFeature as s, require_dist_cjs as t };
