import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { c as readErrorName, i as formatErrorMessage, r as extractErrorCode, t as collectErrorGraphCandidates } from "./errors-VfATXfah.js";
import "./error-runtime-BnVeBNYa.js";
import "./string-coerce-runtime-Ce59bOpy.js";
//#region extensions/telegram/src/network-errors.ts
const TELEGRAM_NETWORK_ORIGIN = Symbol("openclaw.telegram.network-origin");
const RECOVERABLE_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_ABORTED",
	"ECONNABORTED",
	"ERR_NETWORK"
]);
/**
* Error codes that are safe to retry for non-idempotent send operations (e.g. sendMessage).
*
* These represent failures that occur *before* the request reaches Telegram's servers,
* meaning the message was definitely not delivered and it is safe to retry.
*
* Contrast with RECOVERABLE_ERROR_CODES which includes codes like ECONNRESET and ETIMEDOUT
* that can fire *after* Telegram has already received and delivered a message — retrying
* those would cause duplicate messages.
*/
const PRE_CONNECT_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH"
]);
const RECOVERABLE_ERROR_NAMES = new Set([
	"AbortError",
	"TimeoutError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError"
]);
const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE = /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;
const RECOVERABLE_MESSAGE_SNIPPETS = [
	"undici",
	"network error",
	"network request",
	"client network socket disconnected",
	"socket hang up",
	"getaddrinfo",
	"timeout",
	"timed out"
];
function collectTelegramErrorCandidates(err) {
	return collectErrorGraphCandidates(err, (current) => {
		const nested = [current.cause, current.reason];
		if (Array.isArray(current.errors)) nested.push(...current.errors);
		if (readErrorName(current) === "HttpError") nested.push(current.error);
		return nested;
	});
}
function normalizeCode(code) {
	return code?.trim().toUpperCase() ?? "";
}
function getErrorCode(err) {
	const direct = extractErrorCode(err);
	if (direct) return direct;
	if (!err || typeof err !== "object") return;
	const errno = err.errno;
	if (typeof errno === "string") return errno;
	if (typeof errno === "number") return String(errno);
}
function normalizeTelegramNetworkMethod(method) {
	const trimmed = method?.trim();
	if (!trimmed) return null;
	return normalizeLowercaseStringOrEmpty(trimmed);
}
function tagTelegramNetworkError(err, origin) {
	if (!err || typeof err !== "object") return;
	Object.defineProperty(err, TELEGRAM_NETWORK_ORIGIN, {
		value: {
			method: normalizeTelegramNetworkMethod(origin.method),
			url: typeof origin.url === "string" && origin.url.trim() ? origin.url : null
		},
		configurable: true
	});
}
function getTelegramNetworkErrorOrigin(err) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object") continue;
		const origin = candidate[TELEGRAM_NETWORK_ORIGIN];
		if (!origin || typeof origin !== "object") continue;
		return {
			method: "method" in origin && typeof origin.method === "string" ? origin.method : null,
			url: "url" in origin && typeof origin.url === "string" ? origin.url : null
		};
	}
	return null;
}
function isTelegramPollingNetworkError(err) {
	return getTelegramNetworkErrorOrigin(err)?.method === "getupdates";
}
/**
* Returns true if the error is safe to retry for a non-idempotent Telegram send operation
* (e.g. sendMessage). Only matches errors that are guaranteed to have occurred *before*
* the request reached Telegram's servers, preventing duplicate message delivery.
*
* Use this instead of isRecoverableTelegramNetworkError for sendMessage/sendPhoto/etc.
* calls where a retry would create a duplicate visible message.
*/
function isSafeToRetrySendError(err) {
	if (!err) return false;
	for (const candidate of collectTelegramErrorCandidates(err)) {
		const code = normalizeCode(getErrorCode(candidate));
		if (code && PRE_CONNECT_ERROR_CODES.has(code)) return true;
	}
	return false;
}
function hasTelegramErrorCode(err, matches) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) continue;
		const code = candidate.error_code;
		if (typeof code === "number" && matches(code)) return true;
	}
	return false;
}
function hasTelegramRetryAfter(err) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object") continue;
		const retryAfter = "parameters" in candidate && candidate.parameters && typeof candidate.parameters === "object" ? candidate.parameters.retry_after : "response" in candidate && candidate.response && typeof candidate.response === "object" && "parameters" in candidate.response ? candidate.response.parameters?.retry_after : "error" in candidate && candidate.error && typeof candidate.error === "object" && "parameters" in candidate.error ? candidate.error.parameters?.retry_after : void 0;
		if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) return true;
	}
	return false;
}
/** Returns true for HTTP 5xx server errors (error may have been processed). */
function isTelegramServerError(err) {
	return hasTelegramErrorCode(err, (code) => code >= 500);
}
function isTelegramRateLimitError(err) {
	return hasTelegramErrorCode(err, (code) => code === 429) || hasTelegramRetryAfter(err) && /(?:^|\b)429\b|too many requests/i.test(formatErrorMessage(err));
}
/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
function isTelegramClientRejection(err) {
	return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}
function isRecoverableTelegramNetworkError(err, options = {}) {
	if (!err) return false;
	const allowMessageMatch = typeof options.allowMessageMatch === "boolean" ? options.allowMessageMatch : options.context !== "send";
	for (const candidate of collectTelegramErrorCandidates(err)) {
		const code = normalizeCode(getErrorCode(candidate));
		if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;
		const name = readErrorName(candidate);
		if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;
		const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
		if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) return true;
		if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) return true;
		if (allowMessageMatch && message) {
			if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) return true;
		}
	}
	return false;
}
//#endregion
export { isTelegramRateLimitError as a, isTelegramPollingNetworkError as i, isSafeToRetrySendError as n, isTelegramServerError as o, isTelegramClientRejection as r, tagTelegramNetworkError as s, isRecoverableTelegramNetworkError as t };
