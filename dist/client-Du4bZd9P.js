import { n as __esmMin, o as __toESM, r as __exportAll } from "./chunk-CNf5ZN-e.js";
import { At as EndpointError, Dt as isValidHostLabel, Gt as NODE_REGION_CONFIG_OPTIONS, Hn as getSmithyContext$1, Kt as REGION_ENV_NAME, M as parseUrl, Ot as customEndpointFunctions, Tn as parseRfc7231DateTime, Tt as isIpAddress, Ut as resolveRegionConfig, Vn as normalizeProvider$1, Wn as require_dist_cjs, Wt as NODE_REGION_CONFIG_FILE_OPTIONS, Y as requestBuilder, dt as init_serde, en as loadConfig, et as HttpResponse, k as init_protocols, n as init_client$1, nt as HttpRequest, pt as v4, qt as REGION_INI_NAME, r as NoOpLogger, rn as booleanSelector, tn as SelectorType, vt as init_endpoints, xt as resolveEndpoint, zt as init_config$1 } from "./client-hKay7jF9.js";
import { env, versions } from "node:process";
import { join, normalize, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { platform, release } from "node:os";
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
var init_constants$2 = __esmMin((() => {
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
	init_constants$2();
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
var init_constants$1 = __esmMin((() => {
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
	init_constants$1();
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
var Retry;
var init_retries_2026_config = __esmMin((() => {
	Retry = class Retry {
		static v2026 = typeof process !== "undefined" && process.env?.SMITHY_NEW_RETRIES_2026 === "true";
		static delay() {
			return Retry.v2026 ? 50 : 100;
		}
		static throttlingDelay() {
			return Retry.v2026 ? 1e3 : 500;
		}
		static cost() {
			return Retry.v2026 ? 14 : 5;
		}
		static throttlingCost() {
			return Retry.v2026 ? 5 : 10;
		}
		static modifiedCostType() {
			return Retry.v2026 ? "THROTTLING" : "TRANSIENT";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/retry/util-retry/DefaultRetryBackoffStrategy.js
var DefaultRetryBackoffStrategy;
var init_DefaultRetryBackoffStrategy = __esmMin((() => {
	init_constants$1();
	init_retries_2026_config();
	DefaultRetryBackoffStrategy = class {
		x = Retry.delay();
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
	init_constants$1();
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
	init_constants$1();
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
			this.baseDelay ??= Retry.delay();
			this.retryBackoffStrategy ??= new DefaultRetryBackoffStrategy();
		}
		async acquireInitialRetryToken(retryTokenScope) {
			return new DefaultRetryToken(Retry.delay(), 0, void 0, Retry.v2026 && retryTokenScope.includes(":longpoll"));
		}
		async refreshRetryTokenForRetry(token, errorInfo) {
			const maxAttempts = await this.getMaxAttempts();
			const retryCode = this.retryCode(token, errorInfo, maxAttempts);
			const shouldRetry = retryCode === 0;
			const isLongPoll = token.isLongPoll?.();
			if (shouldRetry || isLongPoll) {
				const errorType = errorInfo.errorType;
				this.retryBackoffStrategy.setDelayBase(errorType === "THROTTLING" ? Retry.throttlingDelay() : this.baseDelay);
				const delayFromErrorType = this.retryBackoffStrategy.computeNextBackoffDelay(token.getRetryCount());
				let retryDelay = delayFromErrorType;
				if (errorInfo.retryAfterHint instanceof Date) retryDelay = Math.max(delayFromErrorType, Math.min(errorInfo.retryAfterHint.getTime() - Date.now(), delayFromErrorType + 5e3));
				if (!shouldRetry) throw Object.assign(/* @__PURE__ */ new Error("No retry token available"), { $backoff: Retry.v2026 && retryCode === refusal.capacity && isLongPoll ? retryDelay : 0 });
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
			return errorType === Retry.modifiedCostType() ? Retry.throttlingCost() : Retry.cost();
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
		constructor(maxAttempts, computeNextBackoffDelay = Retry.delay()) {
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
	init_constants$1();
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
	init_constants$1();
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
	init_constants$1();
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
var init_configurations$1 = __esmMin((() => {
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
		const maxAttempts = normalizeProvider$1(input.maxAttempts ?? 3);
		let controller = retryStrategy ? Promise.resolve(retryStrategy) : void 0;
		const getDefault = async () => await normalizeProvider$1(retryMode)() === RETRY_MODES.ADAPTIVE ? new AdaptiveRetryStrategy$1(maxAttempts) : new StandardRetryStrategy$1(maxAttempts);
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
	init_constants$1();
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
	Retry: () => Retry,
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
	init_constants$1();
	init_retries_2026_config();
	init_AdaptiveRetryStrategy();
	init_StandardRetryStrategy();
	init_delayDecider();
	init_retryDecider();
	init_configurations$1();
	init_omitRetryHeadersMiddleware();
	init_parseRetryAfterHeader();
	retryMiddleware = bindRetryMiddleware(isStreamingPayload);
	getRetryPlugin = bindGetRetryPlugin(isStreamingPayload);
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/setFeature.js
function setFeature$1(context, feature, value) {
	if (!context.__aws_sdk_context) context.__aws_sdk_context = { features: {} };
	else if (!context.__aws_sdk_context.features) context.__aws_sdk_context.features = {};
	context.__aws_sdk_context.features[feature] = value;
}
var init_setFeature$1 = __esmMin((() => {
	init_retry();
	Retry.v2026 ||= typeof process === "object" && process.env?.AWS_NEW_RETRIES_2026 === "true";
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
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-host-header/hostHeaderMiddleware.js
function resolveHostHeaderConfig(input) {
	return input;
}
var hostHeaderMiddleware, hostHeaderMiddlewareOptions, getHostHeaderPlugin;
var init_hostHeaderMiddleware = __esmMin((() => {
	init_protocols();
	hostHeaderMiddleware = (options) => (next) => async (args) => {
		if (!HttpRequest.isInstance(args.request)) return next(args);
		const { request } = args;
		const { handlerProtocol = "" } = options.requestHandler.metadata || {};
		if (handlerProtocol.indexOf("h2") >= 0 && !request.headers[":authority"]) {
			delete request.headers["host"];
			request.headers[":authority"] = request.hostname + (request.port ? ":" + request.port : "");
		} else if (!request.headers["host"]) {
			let host = request.hostname;
			if (request.port != null) host += `:${request.port}`;
			request.headers["host"] = host;
		}
		return next(args);
	};
	hostHeaderMiddlewareOptions = {
		name: "hostHeaderMiddleware",
		step: "build",
		priority: "low",
		tags: ["HOST"],
		override: true
	};
	getHostHeaderPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(hostHeaderMiddleware(options), hostHeaderMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-logger/loggerMiddleware.js
var loggerMiddleware, loggerMiddlewareOptions, getLoggerPlugin;
var init_loggerMiddleware = __esmMin((() => {
	loggerMiddleware = () => (next, context) => async (args) => {
		try {
			const response = await next(args);
			const { clientName, commandName, logger, dynamoDbDocumentClientOptions = {} } = context;
			const { overrideInputFilterSensitiveLog, overrideOutputFilterSensitiveLog } = dynamoDbDocumentClientOptions;
			const inputFilterSensitiveLog = overrideInputFilterSensitiveLog ?? context.inputFilterSensitiveLog;
			const outputFilterSensitiveLog = overrideOutputFilterSensitiveLog ?? context.outputFilterSensitiveLog;
			const { $metadata, ...outputWithoutMetadata } = response.output;
			logger?.info?.({
				clientName,
				commandName,
				input: inputFilterSensitiveLog(args.input),
				output: outputFilterSensitiveLog(outputWithoutMetadata),
				metadata: $metadata
			});
			return response;
		} catch (error) {
			const { clientName, commandName, logger, dynamoDbDocumentClientOptions = {} } = context;
			const { overrideInputFilterSensitiveLog } = dynamoDbDocumentClientOptions;
			const inputFilterSensitiveLog = overrideInputFilterSensitiveLog ?? context.inputFilterSensitiveLog;
			logger?.error?.({
				clientName,
				commandName,
				input: inputFilterSensitiveLog(args.input),
				error,
				metadata: error.$metadata
			});
			throw error;
		}
	};
	loggerMiddlewareOptions = {
		name: "loggerMiddleware",
		tags: ["LOGGER"],
		step: "initialize",
		override: true
	};
	getLoggerPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(loggerMiddleware(), loggerMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-recursion-detection/configuration.js
var recursionDetectionMiddlewareOptions;
var init_configuration = __esmMin((() => {
	recursionDetectionMiddlewareOptions = {
		step: "build",
		tags: ["RECURSION_DETECTION"],
		name: "recursionDetectionMiddleware",
		override: true,
		priority: "low"
	};
}));
//#endregion
//#region node_modules/@aws/lambda-invoke-store/dist-es/invoke-store.js
var PROTECTED_KEYS, NO_GLOBAL_AWS_LAMBDA, InvokeStoreBase, InvokeStoreSingle, InvokeStoreMulti, InvokeStore;
var init_invoke_store = __esmMin((() => {
	PROTECTED_KEYS = {
		REQUEST_ID: Symbol.for("_AWS_LAMBDA_REQUEST_ID"),
		X_RAY_TRACE_ID: Symbol.for("_AWS_LAMBDA_X_RAY_TRACE_ID"),
		TENANT_ID: Symbol.for("_AWS_LAMBDA_TENANT_ID")
	};
	NO_GLOBAL_AWS_LAMBDA = ["true", "1"].includes(process.env?.AWS_LAMBDA_NODEJS_NO_GLOBAL_AWSLAMBDA ?? "");
	if (!NO_GLOBAL_AWS_LAMBDA) globalThis.awslambda = globalThis.awslambda || {};
	InvokeStoreBase = class {
		static PROTECTED_KEYS = PROTECTED_KEYS;
		isProtectedKey(key) {
			return Object.values(PROTECTED_KEYS).includes(key);
		}
		getRequestId() {
			return this.get(PROTECTED_KEYS.REQUEST_ID) ?? "-";
		}
		getXRayTraceId() {
			return this.get(PROTECTED_KEYS.X_RAY_TRACE_ID);
		}
		getTenantId() {
			return this.get(PROTECTED_KEYS.TENANT_ID);
		}
	};
	InvokeStoreSingle = class extends InvokeStoreBase {
		currentContext;
		getContext() {
			return this.currentContext;
		}
		hasContext() {
			return this.currentContext !== void 0;
		}
		get(key) {
			return this.currentContext?.[key];
		}
		set(key, value) {
			if (this.isProtectedKey(key)) throw new Error(`Cannot modify protected Lambda context field: ${String(key)}`);
			this.currentContext = this.currentContext || {};
			this.currentContext[key] = value;
		}
		run(context, fn) {
			this.currentContext = context;
			return fn();
		}
	};
	InvokeStoreMulti = class InvokeStoreMulti extends InvokeStoreBase {
		als;
		static async create() {
			const instance = new InvokeStoreMulti();
			instance.als = new (await (import("node:async_hooks"))).AsyncLocalStorage();
			return instance;
		}
		getContext() {
			return this.als.getStore();
		}
		hasContext() {
			return this.als.getStore() !== void 0;
		}
		get(key) {
			return this.als.getStore()?.[key];
		}
		set(key, value) {
			if (this.isProtectedKey(key)) throw new Error(`Cannot modify protected Lambda context field: ${String(key)}`);
			const store = this.als.getStore();
			if (!store) throw new Error("No context available");
			store[key] = value;
		}
		run(context, fn) {
			return this.als.run(context, fn);
		}
	};
	(function(InvokeStore) {
		let instance = null;
		async function getInstanceAsync(forceInvokeStoreMulti) {
			if (!instance) instance = (async () => {
				const newInstance = forceInvokeStoreMulti === true || "AWS_LAMBDA_MAX_CONCURRENCY" in process.env ? await InvokeStoreMulti.create() : new InvokeStoreSingle();
				if (!NO_GLOBAL_AWS_LAMBDA && globalThis.awslambda?.InvokeStore) return globalThis.awslambda.InvokeStore;
				else if (!NO_GLOBAL_AWS_LAMBDA && globalThis.awslambda) {
					globalThis.awslambda.InvokeStore = newInstance;
					return newInstance;
				} else return newInstance;
			})();
			return instance;
		}
		InvokeStore.getInstanceAsync = getInstanceAsync;
		InvokeStore._testing = process.env.AWS_LAMBDA_BENCHMARK_MODE === "1" ? { reset: () => {
			instance = null;
			if (globalThis.awslambda?.InvokeStore) delete globalThis.awslambda.InvokeStore;
			globalThis.awslambda = { InvokeStore: void 0 };
		} } : void 0;
	})(InvokeStore || (InvokeStore = {}));
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-recursion-detection/recursionDetectionMiddleware.js
var TRACE_ID_HEADER_NAME, ENV_LAMBDA_FUNCTION_NAME, ENV_TRACE_ID, recursionDetectionMiddleware;
var init_recursionDetectionMiddleware = __esmMin((() => {
	init_invoke_store();
	init_protocols();
	TRACE_ID_HEADER_NAME = "X-Amzn-Trace-Id";
	ENV_LAMBDA_FUNCTION_NAME = "AWS_LAMBDA_FUNCTION_NAME";
	ENV_TRACE_ID = "_X_AMZN_TRACE_ID";
	recursionDetectionMiddleware = () => (next) => async (args) => {
		const { request } = args;
		if (!HttpRequest.isInstance(request)) return next(args);
		const traceIdHeader = Object.keys(request.headers ?? {}).find((h) => h.toLowerCase() === TRACE_ID_HEADER_NAME.toLowerCase()) ?? TRACE_ID_HEADER_NAME;
		if (request.headers.hasOwnProperty(traceIdHeader)) return next(args);
		const functionName = process.env[ENV_LAMBDA_FUNCTION_NAME];
		const traceIdFromEnv = process.env[ENV_TRACE_ID];
		const traceId = (await InvokeStore.getInstanceAsync())?.getXRayTraceId() ?? traceIdFromEnv;
		const nonEmptyString = (str) => typeof str === "string" && str.length > 0;
		if (nonEmptyString(functionName) && nonEmptyString(traceId)) request.headers[TRACE_ID_HEADER_NAME] = traceId;
		return next({
			...args,
			request
		});
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-recursion-detection/getRecursionDetectionPlugin.js
var getRecursionDetectionPlugin;
var init_getRecursionDetectionPlugin = __esmMin((() => {
	init_configuration();
	init_recursionDetectionMiddleware();
	getRecursionDetectionPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(recursionDetectionMiddleware(), recursionDetectionMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/getSmithyContext.js
var import_dist_cjs$1, getSmithyContext;
var init_getSmithyContext = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs();
	getSmithyContext = (context) => context[import_dist_cjs$1.SMITHY_CONTEXT_KEY] || (context[import_dist_cjs$1.SMITHY_CONTEXT_KEY] = {});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-auth-scheme/resolveAuthOptions.js
var resolveAuthOptions;
var init_resolveAuthOptions = __esmMin((() => {
	resolveAuthOptions = (candidateAuthOptions, authSchemePreference) => {
		if (!authSchemePreference || authSchemePreference.length === 0) return candidateAuthOptions;
		const preferredAuthOptions = [];
		for (const preferredSchemeName of authSchemePreference) for (const candidateAuthOption of candidateAuthOptions) if (candidateAuthOption.schemeId.split("#")[1] === preferredSchemeName) preferredAuthOptions.push(candidateAuthOption);
		for (const candidateAuthOption of candidateAuthOptions) if (!preferredAuthOptions.find(({ schemeId }) => schemeId === candidateAuthOption.schemeId)) preferredAuthOptions.push(candidateAuthOption);
		return preferredAuthOptions;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-auth-scheme/httpAuthSchemeMiddleware.js
function convertHttpAuthSchemesToMap(httpAuthSchemes) {
	const map = /* @__PURE__ */ new Map();
	for (const scheme of httpAuthSchemes) map.set(scheme.schemeId, scheme);
	return map;
}
var httpAuthSchemeMiddleware;
var init_httpAuthSchemeMiddleware = __esmMin((() => {
	init_client$1();
	init_resolveAuthOptions();
	httpAuthSchemeMiddleware = (config, mwOptions) => (next, context) => async (args) => {
		const resolvedOptions = resolveAuthOptions(config.httpAuthSchemeProvider(await mwOptions.httpAuthSchemeParametersProvider(config, context, args.input)), config.authSchemePreference ? await config.authSchemePreference() : []);
		const authSchemes = convertHttpAuthSchemesToMap(config.httpAuthSchemes);
		const smithyContext = getSmithyContext$1(context);
		const failureReasons = [];
		for (const option of resolvedOptions) {
			const scheme = authSchemes.get(option.schemeId);
			if (!scheme) {
				failureReasons.push(`HttpAuthScheme \`${option.schemeId}\` was not enabled for this service.`);
				continue;
			}
			const identityProvider = scheme.identityProvider(await mwOptions.identityProviderConfigProvider(config));
			if (!identityProvider) {
				failureReasons.push(`HttpAuthScheme \`${option.schemeId}\` did not have an IdentityProvider configured.`);
				continue;
			}
			const { identityProperties = {}, signingProperties = {} } = option.propertiesExtractor?.(config, context) || {};
			option.identityProperties = Object.assign(option.identityProperties || {}, identityProperties);
			option.signingProperties = Object.assign(option.signingProperties || {}, signingProperties);
			smithyContext.selectedHttpAuthScheme = {
				httpAuthOption: option,
				identity: await identityProvider(option.identityProperties),
				signer: scheme.signer
			};
			break;
		}
		if (!smithyContext.selectedHttpAuthScheme) throw new Error(failureReasons.join("\n"));
		return next(args);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-auth-scheme/getHttpAuthSchemeEndpointRuleSetPlugin.js
var httpAuthSchemeEndpointRuleSetMiddlewareOptions, getHttpAuthSchemeEndpointRuleSetPlugin;
var init_getHttpAuthSchemeEndpointRuleSetPlugin = __esmMin((() => {
	init_httpAuthSchemeMiddleware();
	httpAuthSchemeEndpointRuleSetMiddlewareOptions = {
		step: "serialize",
		tags: ["HTTP_AUTH_SCHEME"],
		name: "httpAuthSchemeMiddleware",
		override: true,
		relation: "before",
		toMiddleware: "endpointV2Middleware"
	};
	getHttpAuthSchemeEndpointRuleSetPlugin = (config, { httpAuthSchemeParametersProvider, identityProviderConfigProvider }) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(httpAuthSchemeMiddleware(config, {
			httpAuthSchemeParametersProvider,
			identityProviderConfigProvider
		}), httpAuthSchemeEndpointRuleSetMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-auth-scheme/getHttpAuthSchemePlugin.js
var httpAuthSchemeMiddlewareOptions, getHttpAuthSchemePlugin;
var init_getHttpAuthSchemePlugin = __esmMin((() => {
	init_httpAuthSchemeMiddleware();
	httpAuthSchemeMiddlewareOptions = {
		step: "serialize",
		tags: ["HTTP_AUTH_SCHEME"],
		name: "httpAuthSchemeMiddleware",
		override: true,
		relation: "before",
		toMiddleware: "serializerMiddleware"
	};
	getHttpAuthSchemePlugin = (config, { httpAuthSchemeParametersProvider, identityProviderConfigProvider }) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(httpAuthSchemeMiddleware(config, {
			httpAuthSchemeParametersProvider,
			identityProviderConfigProvider
		}), httpAuthSchemeMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-auth-scheme/index.js
var init_middleware_http_auth_scheme = __esmMin((() => {
	init_httpAuthSchemeMiddleware();
	init_getHttpAuthSchemeEndpointRuleSetPlugin();
	init_getHttpAuthSchemePlugin();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-signing/httpSigningMiddleware.js
var defaultErrorHandler, defaultSuccessHandler, httpSigningMiddleware;
var init_httpSigningMiddleware = __esmMin((() => {
	init_client$1();
	init_protocols();
	defaultErrorHandler = (signingProperties) => (error) => {
		throw error;
	};
	defaultSuccessHandler = (httpResponse, signingProperties) => {};
	httpSigningMiddleware = (config) => (next, context) => async (args) => {
		if (!HttpRequest.isInstance(args.request)) return next(args);
		const scheme = getSmithyContext$1(context).selectedHttpAuthScheme;
		if (!scheme) throw new Error(`No HttpAuthScheme was selected: unable to sign request`);
		const { httpAuthOption: { signingProperties = {} }, identity, signer } = scheme;
		const output = await next({
			...args,
			request: await signer.sign(args.request, identity, signingProperties)
		}).catch((signer.errorHandler || defaultErrorHandler)(signingProperties));
		(signer.successHandler || defaultSuccessHandler)(output.response, signingProperties);
		return output;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-signing/getHttpSigningMiddleware.js
var httpSigningMiddlewareOptions, getHttpSigningPlugin;
var init_getHttpSigningMiddleware = __esmMin((() => {
	init_httpSigningMiddleware();
	httpSigningMiddlewareOptions = {
		step: "finalizeRequest",
		tags: ["HTTP_SIGNING"],
		name: "httpSigningMiddleware",
		aliases: [
			"apiKeyMiddleware",
			"tokenMiddleware",
			"awsAuthMiddleware"
		],
		override: true,
		relation: "after",
		toMiddleware: "retryMiddleware"
	};
	getHttpSigningPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(httpSigningMiddleware(config), httpSigningMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/middleware-http-signing/index.js
var init_middleware_http_signing = __esmMin((() => {
	init_httpSigningMiddleware();
	init_getHttpSigningMiddleware();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/normalizeProvider.js
var normalizeProvider;
var init_normalizeProvider = __esmMin((() => {
	normalizeProvider = (input) => {
		if (typeof input === "function") return input;
		const promisified = Promise.resolve(input);
		return () => promisified;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/pagination/createPaginator.js
function createPaginator(ClientCtor, CommandCtor, inputTokenName, outputTokenName, pageSizeTokenName) {
	return async function* paginateOperation(config, input, ...additionalArguments) {
		const _input = input;
		let token = config.startingToken ?? _input[inputTokenName];
		let hasNext = true;
		let page;
		while (hasNext) {
			_input[inputTokenName] = token;
			if (pageSizeTokenName) _input[pageSizeTokenName] = _input[pageSizeTokenName] ?? config.pageSize;
			if (config.client instanceof ClientCtor) page = await makePagedClientRequest(CommandCtor, config.client, input, config.withCommand, ...additionalArguments);
			else throw new Error(`Invalid client, expected instance of ${ClientCtor.name}`);
			yield page;
			const prevToken = token;
			token = get(page, outputTokenName);
			hasNext = !!(token && (!config.stopOnSameToken || token !== prevToken));
		}
		return void 0;
	};
}
var makePagedClientRequest, get;
var init_createPaginator = __esmMin((() => {
	makePagedClientRequest = async (CommandCtor, client, input, withCommand = (_) => _, ...args) => {
		let command = new CommandCtor(input);
		command = withCommand(command) ?? command;
		return await client.send(command, ...args);
	};
	get = (fromObject, path) => {
		let cursor = fromObject;
		const pathComponents = path.split(".");
		for (const step of pathComponents) {
			if (!cursor || typeof cursor !== "object") return;
			cursor = cursor[step];
		}
		return cursor;
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/request-builder/requestBuilder.js
var init_requestBuilder = __esmMin((() => {
	init_protocols();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/setFeature.js
function setFeature(context, feature, value) {
	if (!context.__smithy_context) context.__smithy_context = { features: {} };
	else if (!context.__smithy_context.features) context.__smithy_context.features = {};
	context.__smithy_context.features[feature] = value;
}
var init_setFeature = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/DefaultIdentityProviderConfig.js
var DefaultIdentityProviderConfig;
var init_DefaultIdentityProviderConfig = __esmMin((() => {
	DefaultIdentityProviderConfig = class {
		authSchemes = /* @__PURE__ */ new Map();
		constructor(config) {
			for (const key in config) {
				const value = config[key];
				if (value !== void 0) this.authSchemes.set(key, value);
			}
		}
		getIdentityProvider(schemeId) {
			return this.authSchemes.get(schemeId);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/httpAuthSchemes/httpApiKeyAuth.js
var import_dist_cjs, HttpApiKeyAuthSigner;
var init_httpApiKeyAuth = __esmMin((() => {
	init_protocols();
	import_dist_cjs = require_dist_cjs();
	HttpApiKeyAuthSigner = class {
		async sign(httpRequest, identity, signingProperties) {
			if (!signingProperties) throw new Error("request could not be signed with `apiKey` since the `name` and `in` signer properties are missing");
			if (!signingProperties.name) throw new Error("request could not be signed with `apiKey` since the `name` signer property is missing");
			if (!signingProperties.in) throw new Error("request could not be signed with `apiKey` since the `in` signer property is missing");
			if (!identity.apiKey) throw new Error("request could not be signed with `apiKey` since the `apiKey` is not defined");
			const clonedRequest = HttpRequest.clone(httpRequest);
			if (signingProperties.in === import_dist_cjs.HttpApiKeyAuthLocation.QUERY) clonedRequest.query[signingProperties.name] = identity.apiKey;
			else if (signingProperties.in === import_dist_cjs.HttpApiKeyAuthLocation.HEADER) clonedRequest.headers[signingProperties.name] = signingProperties.scheme ? `${signingProperties.scheme} ${identity.apiKey}` : identity.apiKey;
			else throw new Error("request can only be signed with `apiKey` locations `query` or `header`, but found: `" + signingProperties.in + "`");
			return clonedRequest;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/httpAuthSchemes/httpBearerAuth.js
var HttpBearerAuthSigner;
var init_httpBearerAuth = __esmMin((() => {
	init_protocols();
	HttpBearerAuthSigner = class {
		async sign(httpRequest, identity, signingProperties) {
			const clonedRequest = HttpRequest.clone(httpRequest);
			if (!identity.token) throw new Error("request could not be signed with `token` since the `token` is not defined");
			clonedRequest.headers["Authorization"] = `Bearer ${identity.token}`;
			return clonedRequest;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/httpAuthSchemes/noAuth.js
var NoAuthSigner;
var init_noAuth = __esmMin((() => {
	NoAuthSigner = class {
		async sign(httpRequest, identity, signingProperties) {
			return httpRequest;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/httpAuthSchemes/index.js
var init_httpAuthSchemes = __esmMin((() => {
	init_httpApiKeyAuth();
	init_httpBearerAuth();
	init_noAuth();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/memoizeIdentityProvider.js
var createIsIdentityExpiredFunction, EXPIRATION_MS, isIdentityExpired, doesIdentityRequireRefresh, memoizeIdentityProvider;
var init_memoizeIdentityProvider = __esmMin((() => {
	createIsIdentityExpiredFunction = (expirationMs) => function isIdentityExpired(identity) {
		return doesIdentityRequireRefresh(identity) && identity.expiration.getTime() - Date.now() < expirationMs;
	};
	EXPIRATION_MS = 3e5;
	isIdentityExpired = createIsIdentityExpiredFunction(EXPIRATION_MS);
	doesIdentityRequireRefresh = (identity) => identity.expiration !== void 0;
	memoizeIdentityProvider = (provider, isExpired, requiresRefresh) => {
		if (provider === void 0) return;
		const normalizedProvider = typeof provider !== "function" ? async () => Promise.resolve(provider) : provider;
		let resolved;
		let pending;
		let hasResult;
		let isConstant = false;
		const coalesceProvider = async (options) => {
			if (!pending) pending = normalizedProvider(options);
			try {
				resolved = await pending;
				hasResult = true;
				isConstant = false;
			} finally {
				pending = void 0;
			}
			return resolved;
		};
		if (isExpired === void 0) return async (options) => {
			if (!hasResult || options?.forceRefresh) resolved = await coalesceProvider(options);
			return resolved;
		};
		return async (options) => {
			if (!hasResult || options?.forceRefresh) resolved = await coalesceProvider(options);
			if (isConstant) return resolved;
			if (!requiresRefresh(resolved)) {
				isConstant = true;
				return resolved;
			}
			if (isExpired(resolved)) {
				await coalesceProvider(options);
				return resolved;
			}
			return resolved;
		};
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/util-identity-and-auth/index.js
var init_util_identity_and_auth = __esmMin((() => {
	init_DefaultIdentityProviderConfig();
	init_httpAuthSchemes();
	init_memoizeIdentityProvider();
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/index.js
var dist_es_exports = /* @__PURE__ */ __exportAll({
	DefaultIdentityProviderConfig: () => DefaultIdentityProviderConfig,
	EXPIRATION_MS: () => EXPIRATION_MS,
	HttpApiKeyAuthSigner: () => HttpApiKeyAuthSigner,
	HttpBearerAuthSigner: () => HttpBearerAuthSigner,
	NoAuthSigner: () => NoAuthSigner,
	createIsIdentityExpiredFunction: () => createIsIdentityExpiredFunction,
	createPaginator: () => createPaginator,
	doesIdentityRequireRefresh: () => doesIdentityRequireRefresh,
	getHttpAuthSchemeEndpointRuleSetPlugin: () => getHttpAuthSchemeEndpointRuleSetPlugin,
	getHttpAuthSchemePlugin: () => getHttpAuthSchemePlugin,
	getHttpSigningPlugin: () => getHttpSigningPlugin,
	getSmithyContext: () => getSmithyContext,
	httpAuthSchemeEndpointRuleSetMiddlewareOptions: () => httpAuthSchemeEndpointRuleSetMiddlewareOptions,
	httpAuthSchemeMiddleware: () => httpAuthSchemeMiddleware,
	httpAuthSchemeMiddlewareOptions: () => httpAuthSchemeMiddlewareOptions,
	httpSigningMiddleware: () => httpSigningMiddleware,
	httpSigningMiddlewareOptions: () => httpSigningMiddlewareOptions,
	isIdentityExpired: () => isIdentityExpired,
	memoizeIdentityProvider: () => memoizeIdentityProvider,
	normalizeProvider: () => normalizeProvider,
	requestBuilder: () => requestBuilder,
	setFeature: () => setFeature
});
var init_dist_es = __esmMin((() => {
	init_getSmithyContext();
	init_middleware_http_auth_scheme();
	init_middleware_http_signing();
	init_normalizeProvider();
	init_createPaginator();
	init_requestBuilder();
	init_setFeature();
	init_util_identity_and_auth();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-user-agent/configurations.js
function isValidUserAgentAppId(appId) {
	if (appId === void 0) return true;
	return typeof appId === "string" && appId.length <= 50;
}
function resolveUserAgentConfig(input) {
	const normalizedAppIdProvider = normalizeProvider(input.userAgentAppId ?? void 0);
	const { customUserAgent } = input;
	return Object.assign(input, {
		customUserAgent: typeof customUserAgent === "string" ? [[customUserAgent]] : customUserAgent,
		userAgentAppId: async () => {
			const appId = await normalizedAppIdProvider();
			if (!isValidUserAgentAppId(appId)) {
				const logger = input.logger?.constructor?.name === "NoOpLogger" || !input.logger ? console : input.logger;
				if (typeof appId !== "string") logger?.warn("userAgentAppId must be a string or undefined.");
				else if (appId.length > 50) logger?.warn("The provided userAgentAppId exceeds the maximum length of 50 characters.");
			}
			return appId;
		}
	});
}
var init_configurations = __esmMin((() => {
	init_dist_es();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/lib/aws/partitions.js
var partitionsInfo;
var init_partitions = __esmMin((() => {
	partitionsInfo = {
		"partitions": [
			{
				"id": "aws",
				"outputs": {
					"dnsSuffix": "amazonaws.com",
					"dualStackDnsSuffix": "api.aws",
					"implicitGlobalRegion": "us-east-1",
					"name": "aws",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^(us|eu|ap|sa|ca|me|af|il|mx)\\-\\w+\\-\\d+$",
				"regions": {
					"af-south-1": { "description": "Africa (Cape Town)" },
					"ap-east-1": { "description": "Asia Pacific (Hong Kong)" },
					"ap-east-2": { "description": "Asia Pacific (Taipei)" },
					"ap-northeast-1": { "description": "Asia Pacific (Tokyo)" },
					"ap-northeast-2": { "description": "Asia Pacific (Seoul)" },
					"ap-northeast-3": { "description": "Asia Pacific (Osaka)" },
					"ap-south-1": { "description": "Asia Pacific (Mumbai)" },
					"ap-south-2": { "description": "Asia Pacific (Hyderabad)" },
					"ap-southeast-1": { "description": "Asia Pacific (Singapore)" },
					"ap-southeast-2": { "description": "Asia Pacific (Sydney)" },
					"ap-southeast-3": { "description": "Asia Pacific (Jakarta)" },
					"ap-southeast-4": { "description": "Asia Pacific (Melbourne)" },
					"ap-southeast-5": { "description": "Asia Pacific (Malaysia)" },
					"ap-southeast-6": { "description": "Asia Pacific (New Zealand)" },
					"ap-southeast-7": { "description": "Asia Pacific (Thailand)" },
					"aws-global": { "description": "aws global region" },
					"ca-central-1": { "description": "Canada (Central)" },
					"ca-west-1": { "description": "Canada West (Calgary)" },
					"eu-central-1": { "description": "Europe (Frankfurt)" },
					"eu-central-2": { "description": "Europe (Zurich)" },
					"eu-north-1": { "description": "Europe (Stockholm)" },
					"eu-south-1": { "description": "Europe (Milan)" },
					"eu-south-2": { "description": "Europe (Spain)" },
					"eu-west-1": { "description": "Europe (Ireland)" },
					"eu-west-2": { "description": "Europe (London)" },
					"eu-west-3": { "description": "Europe (Paris)" },
					"il-central-1": { "description": "Israel (Tel Aviv)" },
					"me-central-1": { "description": "Middle East (UAE)" },
					"me-south-1": { "description": "Middle East (Bahrain)" },
					"mx-central-1": { "description": "Mexico (Central)" },
					"sa-east-1": { "description": "South America (Sao Paulo)" },
					"us-east-1": { "description": "US East (N. Virginia)" },
					"us-east-2": { "description": "US East (Ohio)" },
					"us-west-1": { "description": "US West (N. California)" },
					"us-west-2": { "description": "US West (Oregon)" }
				}
			},
			{
				"id": "aws-cn",
				"outputs": {
					"dnsSuffix": "amazonaws.com.cn",
					"dualStackDnsSuffix": "api.amazonwebservices.com.cn",
					"implicitGlobalRegion": "cn-northwest-1",
					"name": "aws-cn",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^cn\\-\\w+\\-\\d+$",
				"regions": {
					"aws-cn-global": { "description": "aws-cn global region" },
					"cn-north-1": { "description": "China (Beijing)" },
					"cn-northwest-1": { "description": "China (Ningxia)" }
				}
			},
			{
				"id": "aws-eusc",
				"outputs": {
					"dnsSuffix": "amazonaws.eu",
					"dualStackDnsSuffix": "api.amazonwebservices.eu",
					"implicitGlobalRegion": "eusc-de-east-1",
					"name": "aws-eusc",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^eusc\\-(de)\\-\\w+\\-\\d+$",
				"regions": { "eusc-de-east-1": { "description": "AWS European Sovereign Cloud (Germany)" } }
			},
			{
				"id": "aws-iso",
				"outputs": {
					"dnsSuffix": "c2s.ic.gov",
					"dualStackDnsSuffix": "api.aws.ic.gov",
					"implicitGlobalRegion": "us-iso-east-1",
					"name": "aws-iso",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^us\\-iso\\-\\w+\\-\\d+$",
				"regions": {
					"aws-iso-global": { "description": "aws-iso global region" },
					"us-iso-east-1": { "description": "US ISO East" },
					"us-iso-west-1": { "description": "US ISO WEST" }
				}
			},
			{
				"id": "aws-iso-b",
				"outputs": {
					"dnsSuffix": "sc2s.sgov.gov",
					"dualStackDnsSuffix": "api.aws.scloud",
					"implicitGlobalRegion": "us-isob-east-1",
					"name": "aws-iso-b",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^us\\-isob\\-\\w+\\-\\d+$",
				"regions": {
					"aws-iso-b-global": { "description": "aws-iso-b global region" },
					"us-isob-east-1": { "description": "US ISOB East (Ohio)" },
					"us-isob-west-1": { "description": "US ISOB West" }
				}
			},
			{
				"id": "aws-iso-e",
				"outputs": {
					"dnsSuffix": "cloud.adc-e.uk",
					"dualStackDnsSuffix": "api.cloud-aws.adc-e.uk",
					"implicitGlobalRegion": "eu-isoe-west-1",
					"name": "aws-iso-e",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^eu\\-isoe\\-\\w+\\-\\d+$",
				"regions": {
					"aws-iso-e-global": { "description": "aws-iso-e global region" },
					"eu-isoe-west-1": { "description": "EU ISOE West" }
				}
			},
			{
				"id": "aws-iso-f",
				"outputs": {
					"dnsSuffix": "csp.hci.ic.gov",
					"dualStackDnsSuffix": "api.aws.hci.ic.gov",
					"implicitGlobalRegion": "us-isof-south-1",
					"name": "aws-iso-f",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^us\\-isof\\-\\w+\\-\\d+$",
				"regions": {
					"aws-iso-f-global": { "description": "aws-iso-f global region" },
					"us-isof-east-1": { "description": "US ISOF EAST" },
					"us-isof-south-1": { "description": "US ISOF SOUTH" }
				}
			},
			{
				"id": "aws-us-gov",
				"outputs": {
					"dnsSuffix": "amazonaws.com",
					"dualStackDnsSuffix": "api.aws",
					"implicitGlobalRegion": "us-gov-west-1",
					"name": "aws-us-gov",
					"supportsDualStack": true,
					"supportsFIPS": true
				},
				"regionRegex": "^us\\-gov\\-\\w+\\-\\d+$",
				"regions": {
					"aws-us-gov-global": { "description": "aws-us-gov global region" },
					"us-gov-east-1": { "description": "AWS GovCloud (US-East)" },
					"us-gov-west-1": { "description": "AWS GovCloud (US-West)" }
				}
			}
		],
		"version": "1.1"
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/lib/aws/partition.js
var selectedPartitionsInfo, selectedUserAgentPrefix, partition, setPartitionInfo, useDefaultPartitionInfo, getUserAgentPrefix;
var init_partition = __esmMin((() => {
	init_partitions();
	selectedPartitionsInfo = partitionsInfo;
	selectedUserAgentPrefix = "";
	partition = (value) => {
		const { partitions } = selectedPartitionsInfo;
		for (const partition of partitions) {
			const { regions, outputs } = partition;
			for (const [region, regionData] of Object.entries(regions)) if (region === value) return {
				...outputs,
				...regionData
			};
		}
		for (const partition of partitions) {
			const { regionRegex, outputs } = partition;
			if (new RegExp(regionRegex).test(value)) return { ...outputs };
		}
		const DEFAULT_PARTITION = partitions.find((partition) => partition.id === "aws");
		if (!DEFAULT_PARTITION) throw new Error("Provided region was not found in the partition array or regex, and default partition with id 'aws' doesn't exist.");
		return { ...DEFAULT_PARTITION.outputs };
	};
	setPartitionInfo = (partitionsInfo, userAgentPrefix = "") => {
		selectedPartitionsInfo = partitionsInfo;
		selectedUserAgentPrefix = userAgentPrefix;
	};
	useDefaultPartitionInfo = () => {
		setPartitionInfo(partitionsInfo, "");
	};
	getUserAgentPrefix = () => selectedUserAgentPrefix;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-user-agent/check-features.js
async function checkFeatures(context, config, args) {
	if (args.request?.headers?.["smithy-protocol"] === "rpc-v2-cbor") setFeature$1(context, "PROTOCOL_RPC_V2_CBOR", "M");
	if (typeof config.retryStrategy === "function") {
		const retryStrategy = await config.retryStrategy();
		if (typeof retryStrategy.mode === "string") switch (retryStrategy.mode) {
			case RETRY_MODES.ADAPTIVE:
				setFeature$1(context, "RETRY_MODE_ADAPTIVE", "F");
				break;
			case RETRY_MODES.STANDARD:
				setFeature$1(context, "RETRY_MODE_STANDARD", "E");
				break;
		}
	}
	if (typeof config.accountIdEndpointMode === "function") {
		const endpointV2 = context.endpointV2;
		if (String(endpointV2?.url?.hostname).match(ACCOUNT_ID_ENDPOINT_REGEX)) setFeature$1(context, "ACCOUNT_ID_ENDPOINT", "O");
		switch (await config.accountIdEndpointMode?.()) {
			case "disabled":
				setFeature$1(context, "ACCOUNT_ID_MODE_DISABLED", "Q");
				break;
			case "preferred":
				setFeature$1(context, "ACCOUNT_ID_MODE_PREFERRED", "P");
				break;
			case "required":
				setFeature$1(context, "ACCOUNT_ID_MODE_REQUIRED", "R");
				break;
		}
	}
	const identity = context.__smithy_context?.selectedHttpAuthScheme?.identity;
	if (identity?.$source) {
		const credentials = identity;
		if (credentials.accountId) setFeature$1(context, "RESOLVED_ACCOUNT_ID", "T");
		for (const [key, value] of Object.entries(credentials.$source ?? {})) setFeature$1(context, key, value);
	}
}
var ACCOUNT_ID_ENDPOINT_REGEX;
var init_check_features = __esmMin((() => {
	init_retry();
	init_setFeature$1();
	ACCOUNT_ID_ENDPOINT_REGEX = /\d{12}\.ddb/;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-user-agent/constants.js
var USER_AGENT, X_AMZ_USER_AGENT, UA_NAME_ESCAPE_REGEX, UA_VALUE_ESCAPE_REGEX;
var init_constants = __esmMin((() => {
	USER_AGENT = "user-agent";
	X_AMZ_USER_AGENT = "x-amz-user-agent";
	UA_NAME_ESCAPE_REGEX = /[^!$%&'*+\-.^_`|~\w]/g;
	UA_VALUE_ESCAPE_REGEX = /[^!$%&'*+\-.^_`|~\w#]/g;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-user-agent/encode-features.js
function encodeFeatures(features) {
	let buffer = "";
	for (const key in features) {
		const val = features[key];
		if (buffer.length + val.length + 1 <= BYTE_LIMIT) {
			if (buffer.length) buffer += "," + val;
			else buffer += val;
			continue;
		}
		break;
	}
	return buffer;
}
var BYTE_LIMIT;
var init_encode_features = __esmMin((() => {
	BYTE_LIMIT = 1024;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/middleware-user-agent/user-agent-middleware.js
var userAgentMiddleware, escapeUserAgent, getUserAgentMiddlewareOptions, getUserAgentPlugin;
var init_user_agent_middleware = __esmMin((() => {
	init_protocols();
	init_partition();
	init_check_features();
	init_constants();
	init_encode_features();
	userAgentMiddleware = (options) => (next, context) => async (args) => {
		const { request } = args;
		if (!HttpRequest.isInstance(request)) return next(args);
		const { headers } = request;
		const userAgent = context?.userAgent?.map(escapeUserAgent) || [];
		const defaultUserAgent = (await options.defaultUserAgentProvider()).map(escapeUserAgent);
		await checkFeatures(context, options, args);
		const awsContext = context;
		defaultUserAgent.push(`m/${encodeFeatures(Object.assign({}, context.__smithy_context?.features, awsContext.__aws_sdk_context?.features))}`);
		const customUserAgent = options?.customUserAgent?.map(escapeUserAgent) || [];
		const appId = await options.userAgentAppId();
		if (appId) defaultUserAgent.push(escapeUserAgent([`app`, `${appId}`]));
		const prefix = getUserAgentPrefix();
		const sdkUserAgentValue = (prefix ? [prefix] : []).concat([
			...defaultUserAgent,
			...userAgent,
			...customUserAgent
		]).join(" ");
		const normalUAValue = [...defaultUserAgent.filter((section) => section.startsWith("aws-sdk-")), ...customUserAgent].join(" ");
		if (options.runtime !== "browser") {
			if (normalUAValue) headers[X_AMZ_USER_AGENT] = headers["x-amz-user-agent"] ? `${headers[USER_AGENT]} ${normalUAValue}` : normalUAValue;
			headers[USER_AGENT] = sdkUserAgentValue;
		} else headers[X_AMZ_USER_AGENT] = sdkUserAgentValue;
		return next({
			...args,
			request
		});
	};
	escapeUserAgent = (userAgentPair) => {
		const name = userAgentPair[0].split("/").map((part) => part.replace(UA_NAME_ESCAPE_REGEX, "-")).join("/");
		const version = userAgentPair[1]?.replace(UA_VALUE_ESCAPE_REGEX, "-");
		const prefixSeparatorIndex = name.indexOf("/");
		const prefix = name.substring(0, prefixSeparatorIndex);
		let uaName = name.substring(prefixSeparatorIndex + 1);
		if (prefix === "api") uaName = uaName.toLowerCase();
		return [
			prefix,
			uaName,
			version
		].filter((item) => item && item.length > 0).reduce((acc, item, index) => {
			switch (index) {
				case 0: return item;
				case 1: return `${acc}/${item}`;
				default: return `${acc}#${item}`;
			}
		}, "");
	};
	getUserAgentMiddlewareOptions = {
		name: "getUserAgentMiddleware",
		step: "build",
		priority: "low",
		tags: ["SET_USER_AGENT", "USER_AGENT"],
		override: true
	};
	getUserAgentPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.add(userAgentMiddleware(config), getUserAgentMiddlewareOptions);
	} });
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/getRuntimeUserAgentPair.js
var getRuntimeUserAgentPair;
var init_getRuntimeUserAgentPair = __esmMin((() => {
	getRuntimeUserAgentPair = () => {
		for (const runtime of [
			"deno",
			"bun",
			"llrt"
		]) if (versions[runtime]) return [`md/${runtime}`, versions[runtime]];
		return ["md/nodejs", versions.node];
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/getNodeModulesParentDirs.js
var getNodeModulesParentDirs;
var init_getNodeModulesParentDirs = __esmMin((() => {
	getNodeModulesParentDirs = (dirname) => {
		const cwd = process.cwd();
		if (!dirname) return [cwd];
		const normalizedPath = normalize(dirname);
		const parts = normalizedPath.split(sep);
		const nodeModulesIndex = parts.indexOf("node_modules");
		const parentDir = nodeModulesIndex !== -1 ? parts.slice(0, nodeModulesIndex).join(sep) : normalizedPath;
		if (cwd === parentDir) return [cwd];
		return [parentDir, cwd];
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/getSanitizedTypeScriptVersion.js
var SEMVER_REGEX, getSanitizedTypeScriptVersion;
var init_getSanitizedTypeScriptVersion = __esmMin((() => {
	SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
	getSanitizedTypeScriptVersion = (version = "") => {
		const match = version.match(SEMVER_REGEX);
		if (!match) return;
		const [major, minor, patch, prerelease] = [
			match[1],
			match[2],
			match[3],
			match[4]
		];
		return prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/getSanitizedDevTypeScriptVersion.js
var ALLOWED_PREFIXES, ALLOWED_DIST_TAGS, getSanitizedDevTypeScriptVersion;
var init_getSanitizedDevTypeScriptVersion = __esmMin((() => {
	init_getSanitizedTypeScriptVersion();
	ALLOWED_PREFIXES = [
		"^",
		"~",
		">=",
		"<=",
		">",
		"<"
	];
	ALLOWED_DIST_TAGS = [
		"latest",
		"beta",
		"dev",
		"rc",
		"insiders",
		"next"
	];
	getSanitizedDevTypeScriptVersion = (version = "") => {
		if (ALLOWED_DIST_TAGS.includes(version)) return version;
		const prefix = ALLOWED_PREFIXES.find((p) => version.startsWith(p)) ?? "";
		const sanitizedTypeScriptVersion = getSanitizedTypeScriptVersion(version.slice(prefix.length));
		if (!sanitizedTypeScriptVersion) return;
		return `${prefix}${sanitizedTypeScriptVersion}`;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/getTypeScriptUserAgentPair.js
var tscVersion, TS_PACKAGE_JSON, getTypeScriptUserAgentPair;
var init_getTypeScriptUserAgentPair = __esmMin((() => {
	init_config$1();
	init_getNodeModulesParentDirs();
	init_getSanitizedDevTypeScriptVersion();
	init_getSanitizedTypeScriptVersion();
	TS_PACKAGE_JSON = join("node_modules", "typescript", "package.json");
	getTypeScriptUserAgentPair = async () => {
		if (tscVersion === null) return;
		else if (typeof tscVersion === "string") return ["md/tsc", tscVersion];
		let isTypeScriptDetectionDisabled = false;
		try {
			isTypeScriptDetectionDisabled = booleanSelector(process.env, "AWS_SDK_JS_TYPESCRIPT_DETECTION_DISABLED", SelectorType.ENV) || false;
		} catch {}
		if (isTypeScriptDetectionDisabled) {
			tscVersion = null;
			return;
		}
		const nodeModulesParentDirs = getNodeModulesParentDirs(typeof __dirname !== "undefined" ? __dirname : void 0);
		let versionFromApp;
		for (const nodeModulesParentDir of nodeModulesParentDirs) try {
			const packageJson = await readFile(join(nodeModulesParentDir, "package.json"), "utf-8");
			const { dependencies, devDependencies } = JSON.parse(packageJson);
			const version = devDependencies?.typescript ?? dependencies?.typescript;
			if (typeof version !== "string") continue;
			versionFromApp = version;
			break;
		} catch {}
		if (!versionFromApp) {
			tscVersion = null;
			return;
		}
		let versionFromNodeModules;
		for (const nodeModulesParentDir of nodeModulesParentDirs) try {
			const packageJson = await readFile(join(nodeModulesParentDir, TS_PACKAGE_JSON), "utf-8");
			const { version } = JSON.parse(packageJson);
			const sanitizedVersion = getSanitizedTypeScriptVersion(version);
			if (typeof sanitizedVersion !== "string") continue;
			versionFromNodeModules = sanitizedVersion;
			break;
		} catch {}
		if (versionFromNodeModules) {
			tscVersion = versionFromNodeModules;
			return ["md/tsc", tscVersion];
		}
		const sanitizedVersion = getSanitizedDevTypeScriptVersion(versionFromApp);
		if (typeof sanitizedVersion !== "string") {
			tscVersion = null;
			return;
		}
		tscVersion = `dev_${sanitizedVersion}`;
		return ["md/tsc", tscVersion];
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/crt-availability.js
var crtAvailability;
var init_crt_availability = __esmMin((() => {
	crtAvailability = { isCrtAvailable: false };
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/is-crt-available.js
var isCrtAvailable;
var init_is_crt_available = __esmMin((() => {
	init_crt_availability();
	isCrtAvailable = () => {
		if (crtAvailability.isCrtAvailable) return ["md/crt-avail"];
		return null;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/defaultUserAgent.js
var createDefaultUserAgentProvider, defaultUserAgent;
var init_defaultUserAgent$1 = __esmMin((() => {
	init_getRuntimeUserAgentPair();
	init_getTypeScriptUserAgentPair();
	init_is_crt_available();
	init_crt_availability();
	createDefaultUserAgentProvider = ({ serviceId, clientVersion }) => {
		const runtimeUserAgentPair = getRuntimeUserAgentPair();
		return async (config) => {
			const sections = [
				["aws-sdk-js", clientVersion],
				["ua", "2.1"],
				[`os/${platform()}`, release()],
				["lang/js"],
				runtimeUserAgentPair
			];
			const typescriptUserAgentPair = await getTypeScriptUserAgentPair();
			if (typescriptUserAgentPair) sections.push(typescriptUserAgentPair);
			const crtAvailable = isCrtAvailable();
			if (crtAvailable) sections.push(crtAvailable);
			if (serviceId) sections.push([`api/${serviceId}`, clientVersion]);
			if (env.AWS_EXECUTION_ENV) sections.push([`exec-env/${env.AWS_EXECUTION_ENV}`]);
			const appId = await config?.userAgentAppId?.();
			return appId ? [...sections, [`app/${appId}`]] : [...sections];
		};
	};
	defaultUserAgent = createDefaultUserAgentProvider;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-node/nodeAppIdConfigOptions.js
var UA_APP_ID_ENV_NAME, UA_APP_ID_INI_NAME, UA_APP_ID_INI_NAME_DEPRECATED, NODE_APP_ID_CONFIG_OPTIONS;
var init_nodeAppIdConfigOptions = __esmMin((() => {
	init_configurations();
	UA_APP_ID_ENV_NAME = "AWS_SDK_UA_APP_ID";
	UA_APP_ID_INI_NAME = "sdk_ua_app_id";
	UA_APP_ID_INI_NAME_DEPRECATED = "sdk-ua-app-id";
	NODE_APP_ID_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => env[UA_APP_ID_ENV_NAME],
		configFileSelector: (profile) => profile["sdk_ua_app_id"] ?? profile[UA_APP_ID_INI_NAME_DEPRECATED],
		default: void 0
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-browser/createUserAgentStringParsingProvider.js
var createUserAgentStringParsingProvider;
var init_createUserAgentStringParsingProvider = __esmMin((() => {
	createUserAgentStringParsingProvider = ({ serviceId, clientVersion }) => async (config) => {
		const module = await import("./es5-BXjfj7tj.js").then((m) => /* @__PURE__ */ __toESM(m.default));
		const parse = module.parse ?? module.default.parse ?? (() => "");
		const parsedUA = typeof window !== "undefined" && window?.navigator?.userAgent ? parse(window.navigator.userAgent) : void 0;
		const sections = [
			["aws-sdk-js", clientVersion],
			["ua", "2.1"],
			[`os/${parsedUA?.os?.name || "other"}`, parsedUA?.os?.version],
			["lang/js"],
			["md/browser", `${parsedUA?.browser?.name ?? "unknown"}_${parsedUA?.browser?.version ?? "unknown"}`]
		];
		if (serviceId) sections.push([`api/${serviceId}`, clientVersion]);
		const appId = await config?.userAgentAppId?.();
		if (appId) sections.push([`app/${appId}`]);
		return sections;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-user-agent-browser/defaultUserAgent.js
var fallback;
var init_defaultUserAgent = __esmMin((() => {
	init_createUserAgentStringParsingProvider();
	fallback = {
		os(ua) {
			if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
			if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
			if (/Windows NT/.test(ua)) return "Windows";
			if (/Android/.test(ua)) return "Android";
			if (/Linux/.test(ua)) return "Linux";
		},
		browser(ua) {
			if (/EdgiOS|EdgA|Edg\//.test(ua)) return "Microsoft Edge";
			if (/Firefox\//.test(ua)) return "Firefox";
			if (/Chrome\//.test(ua)) return "Chrome";
			if (/Safari\//.test(ua)) return "Safari";
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/lib/isIpAddress.js
var init_isIpAddress = __esmMin((() => {
	init_endpoints();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/lib/aws/isVirtualHostableS3Bucket.js
var isVirtualHostableS3Bucket;
var init_isVirtualHostableS3Bucket = __esmMin((() => {
	init_endpoints();
	init_isIpAddress();
	isVirtualHostableS3Bucket = (value, allowSubDomains = false) => {
		if (allowSubDomains) {
			for (const label of value.split(".")) if (!isVirtualHostableS3Bucket(label)) return false;
			return true;
		}
		if (!isValidHostLabel(value)) return false;
		if (value.length < 3 || value.length > 63) return false;
		if (value !== value.toLowerCase()) return false;
		if (isIpAddress(value)) return false;
		return true;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/lib/aws/parseArn.js
var ARN_DELIMITER, RESOURCE_DELIMITER, parseArn;
var init_parseArn = __esmMin((() => {
	ARN_DELIMITER = ":";
	RESOURCE_DELIMITER = "/";
	parseArn = (value) => {
		const segments = value.split(ARN_DELIMITER);
		if (segments.length < 6) return null;
		const [arn, partition, service, region, accountId, ...resourcePath] = segments;
		if (arn !== "arn" || partition === "" || service === "" || resourcePath.join(ARN_DELIMITER) === "") return null;
		return {
			partition,
			service,
			region,
			accountId,
			resourceId: resourcePath.map((resource) => resource.split(RESOURCE_DELIMITER)).flat()
		};
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/aws.js
var awsEndpointFunctions;
var init_aws = __esmMin((() => {
	init_endpoints();
	init_isVirtualHostableS3Bucket();
	init_parseArn();
	init_partition();
	awsEndpointFunctions = {
		isVirtualHostableS3Bucket,
		parseArn,
		partition
	};
	customEndpointFunctions.aws = awsEndpointFunctions;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/resolveEndpoint.js
var init_resolveEndpoint = __esmMin((() => {
	init_endpoints();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/resolveDefaultAwsRegionalEndpointsConfig.js
var resolveDefaultAwsRegionalEndpointsConfig, toEndpointV1;
var init_resolveDefaultAwsRegionalEndpointsConfig = __esmMin((() => {
	init_protocols();
	resolveDefaultAwsRegionalEndpointsConfig = (input) => {
		if (typeof input.endpointProvider !== "function") throw new Error("@aws-sdk/util-endpoint - endpointProvider and endpoint missing in config for this client.");
		const { endpoint } = input;
		if (endpoint === void 0) input.endpoint = async () => {
			return toEndpointV1(input.endpointProvider({
				Region: typeof input.region === "function" ? await input.region() : input.region,
				UseDualStack: typeof input.useDualstackEndpoint === "function" ? await input.useDualstackEndpoint() : input.useDualstackEndpoint,
				UseFIPS: typeof input.useFipsEndpoint === "function" ? await input.useFipsEndpoint() : input.useFipsEndpoint,
				Endpoint: void 0
			}, { logger: input.logger }));
		};
		return input;
	};
	toEndpointV1 = (endpoint) => parseUrl(endpoint.url);
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/util-endpoints/types/EndpointError.js
var init_EndpointError = __esmMin((() => {
	init_endpoints();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/region-config-resolver/awsRegionConfig.js
var init_awsRegionConfig = __esmMin((() => {
	init_config$1();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/region-config-resolver/stsRegionDefaultResolver.js
function stsRegionDefaultResolver(loaderConfig = {}) {
	return loadConfig({
		...NODE_REGION_CONFIG_OPTIONS,
		async default() {
			if (!warning.silence) console.warn("@aws-sdk - WARN - default STS region of us-east-1 used. See @aws-sdk/credential-providers README and set a region explicitly.");
			return "us-east-1";
		}
	}, {
		...NODE_REGION_CONFIG_FILE_OPTIONS,
		...loaderConfig
	});
}
var warning;
var init_stsRegionDefaultResolver = __esmMin((() => {
	init_config$1();
	warning = { silence: false };
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/region-config-resolver/extensions.js
var getAwsRegionExtensionConfiguration, resolveAwsRegionExtensionConfiguration;
var init_extensions = __esmMin((() => {
	getAwsRegionExtensionConfiguration = (runtimeConfig) => {
		return {
			setRegion(region) {
				runtimeConfig.region = region;
			},
			region() {
				return runtimeConfig.region;
			}
		};
	};
	resolveAwsRegionExtensionConfiguration = (awsRegionExtensionConfiguration) => {
		return { region: awsRegionExtensionConfiguration.region() };
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/client/index.js
var client_exports = /* @__PURE__ */ __exportAll({
	DEFAULT_UA_APP_ID: () => void 0,
	EndpointError: () => EndpointError,
	NODE_APP_ID_CONFIG_OPTIONS: () => NODE_APP_ID_CONFIG_OPTIONS,
	NODE_REGION_CONFIG_FILE_OPTIONS: () => NODE_REGION_CONFIG_FILE_OPTIONS,
	NODE_REGION_CONFIG_OPTIONS: () => NODE_REGION_CONFIG_OPTIONS,
	REGION_ENV_NAME: () => REGION_ENV_NAME,
	REGION_INI_NAME: () => REGION_INI_NAME,
	UA_APP_ID_ENV_NAME: () => UA_APP_ID_ENV_NAME,
	UA_APP_ID_INI_NAME: () => UA_APP_ID_INI_NAME,
	awsEndpointFunctions: () => awsEndpointFunctions,
	createDefaultUserAgentProvider: () => createDefaultUserAgentProvider,
	createUserAgentStringParsingProvider: () => createUserAgentStringParsingProvider,
	crtAvailability: () => crtAvailability,
	defaultUserAgent: () => defaultUserAgent,
	emitWarningIfUnsupportedVersion: () => emitWarningIfUnsupportedVersion,
	fallback: () => fallback,
	getAwsRegionExtensionConfiguration: () => getAwsRegionExtensionConfiguration,
	getHostHeaderPlugin: () => getHostHeaderPlugin,
	getLoggerPlugin: () => getLoggerPlugin,
	getLongPollPlugin: () => getLongPollPlugin,
	getRecursionDetectionPlugin: () => getRecursionDetectionPlugin,
	getUserAgentMiddlewareOptions: () => getUserAgentMiddlewareOptions,
	getUserAgentPlugin: () => getUserAgentPlugin,
	getUserAgentPrefix: () => getUserAgentPrefix,
	hostHeaderMiddleware: () => hostHeaderMiddleware,
	hostHeaderMiddlewareOptions: () => hostHeaderMiddlewareOptions,
	isIpAddress: () => isIpAddress,
	isVirtualHostableS3Bucket: () => isVirtualHostableS3Bucket,
	loggerMiddleware: () => loggerMiddleware,
	loggerMiddlewareOptions: () => loggerMiddlewareOptions,
	parseArn: () => parseArn,
	partition: () => partition,
	recursionDetectionMiddleware: () => recursionDetectionMiddleware,
	recursionDetectionMiddlewareOptions: () => recursionDetectionMiddlewareOptions,
	resolveAwsRegionExtensionConfiguration: () => resolveAwsRegionExtensionConfiguration,
	resolveDefaultAwsRegionalEndpointsConfig: () => resolveDefaultAwsRegionalEndpointsConfig,
	resolveEndpoint: () => resolveEndpoint,
	resolveHostHeaderConfig: () => resolveHostHeaderConfig,
	resolveRegionConfig: () => resolveRegionConfig,
	resolveUserAgentConfig: () => resolveUserAgentConfig,
	setCredentialFeature: () => setCredentialFeature,
	setFeature: () => setFeature$1,
	setPartitionInfo: () => setPartitionInfo,
	setTokenFeature: () => setTokenFeature,
	state: () => state,
	stsRegionDefaultResolver: () => stsRegionDefaultResolver,
	stsRegionWarning: () => warning,
	toEndpointV1: () => toEndpointV1,
	useDefaultPartitionInfo: () => useDefaultPartitionInfo,
	userAgentMiddleware: () => userAgentMiddleware
});
var init_client = __esmMin((() => {
	init_emitWarningIfUnsupportedVersion();
	init_longPollMiddleware();
	init_setCredentialFeature();
	init_setFeature$1();
	init_setTokenFeature();
	init_hostHeaderMiddleware();
	init_loggerMiddleware();
	init_configuration();
	init_getRecursionDetectionPlugin();
	init_recursionDetectionMiddleware();
	init_configurations();
	init_user_agent_middleware();
	init_defaultUserAgent$1();
	init_nodeAppIdConfigOptions();
	init_defaultUserAgent();
	init_createUserAgentStringParsingProvider();
	init_aws();
	init_resolveEndpoint();
	init_resolveDefaultAwsRegionalEndpointsConfig();
	init_isIpAddress();
	init_isVirtualHostableS3Bucket();
	init_parseArn();
	init_partition();
	init_EndpointError();
	init_awsRegionConfig();
	init_stsRegionDefaultResolver();
	init_extensions();
}));
//#endregion
export { init_emitWarningIfUnsupportedVersion as $, getHttpSigningPlugin as A, resolveHostHeaderConfig as B, memoizeIdentityProvider as C, init_DefaultIdentityProviderConfig as D, DefaultIdentityProviderConfig as E, init_getRecursionDetectionPlugin as F, NODE_RETRY_MODE_CONFIG_OPTIONS as G, init_retry as H, getLoggerPlugin as I, DEFAULT_RETRY_MODE as J, init_configurations$1 as K, init_loggerMiddleware as L, getHttpAuthSchemeEndpointRuleSetPlugin as M, init_getHttpAuthSchemeEndpointRuleSetPlugin as N, init_normalizeProvider as O, getRecursionDetectionPlugin as P, emitWarningIfUnsupportedVersion as Q, getHostHeaderPlugin as R, isIdentityExpired as S, init_noAuth as T, retry_exports as U, getRetryPlugin as V, NODE_MAX_ATTEMPT_CONFIG_OPTIONS as W, init_setCredentialFeature as X, init_config as Y, setCredentialFeature as Z, resolveUserAgentConfig as _, resolveAwsRegionExtensionConfiguration as a, doesIdentityRequireRefresh as b, awsEndpointFunctions as c, init_nodeAppIdConfigOptions as d, createDefaultUserAgentProvider as f, init_configurations as g, init_user_agent_middleware as h, init_extensions as i, init_getHttpSigningMiddleware as j, normalizeProvider as k, init_aws as l, getUserAgentPlugin as m, init_client as n, init_stsRegionDefaultResolver as o, init_defaultUserAgent$1 as p, resolveRetryConfig as q, getAwsRegionExtensionConfiguration as r, stsRegionDefaultResolver as s, client_exports as t, NODE_APP_ID_CONFIG_OPTIONS as u, dist_es_exports as v, NoAuthSigner as w, init_memoizeIdentityProvider as x, init_dist_es as y, init_hostHeaderMiddleware as z };
