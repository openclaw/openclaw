import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as readErrorName, i as formatErrorMessage, r as extractErrorCode, t as collectErrorGraphCandidates } from "./errors-b3ZrCRlt.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
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
function getNumericHttpStatus(err) {
	if (!err || typeof err !== "object") return;
	const candidate = err;
	for (const value of [
		candidate.error_code,
		candidate.status,
		candidate.statusCode
	]) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
		}
	}
}
function isTelegramMisdirectedRequestError(err) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (normalizeCode(getErrorCode(candidate)) === "421" || getNumericHttpStatus(candidate) === 421) return true;
		const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
		if (/\b421\b/.test(message) && message.includes("misdirected request")) return true;
	}
	return false;
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
	if (isTelegramMisdirectedRequestError(err)) return true;
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
//#region extensions/telegram/src/request-timeouts.ts
const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45e3;
const TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS = 6e4;
const TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS = 5;
const TELEGRAM_REQUEST_TIMEOUTS_MS = {
	deletemycommands: 15e3,
	deletewebhook: 15e3,
	deletemessage: 15e3,
	editforumtopic: 15e3,
	editmessagetext: 15e3,
	getchat: 15e3,
	getfile: 3e4,
	getme: 15e3,
	getupdates: TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
	pinchatmessage: 15e3,
	sendanimation: 3e4,
	sendaudio: 3e4,
	sendchataction: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	senddocument: 3e4,
	sendmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	sendmessagedraft: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	sendphoto: 3e4,
	sendvideo: 3e4,
	sendvoice: 3e4,
	setmessagereaction: 1e4,
	setmycommands: 15e3,
	setwebhook: 15e3
};
function resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) {
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) return;
	return Math.max(1, Math.floor(timeoutSeconds)) * 1e3;
}
function resolveTelegramRequestTimeoutMs(method, timeoutSeconds) {
	if (!method) return;
	const baseTimeoutMs = TELEGRAM_REQUEST_TIMEOUTS_MS[method];
	if (baseTimeoutMs === void 0 || method === "getupdates") return baseTimeoutMs;
	return Math.max(baseTimeoutMs, resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0);
}
function resolveTelegramLongPollTimeoutSeconds(timeoutSeconds) {
	const maxLongPollTimeoutSeconds = Math.max(1, Math.floor(TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1e3) - TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS);
	return Math.min(typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) ? Math.max(1, Math.floor(timeoutSeconds)) : TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS, maxLongPollTimeoutSeconds);
}
function resolveTelegramStartupProbeTimeoutMs(timeoutSeconds) {
	const getMeTimeoutMs = resolveTelegramRequestTimeoutMs("getme") ?? 15e3;
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) return getMeTimeoutMs;
	const configuredTimeoutMs = Math.max(1, Math.floor(timeoutSeconds)) * 1e3;
	return Math.max(getMeTimeoutMs, configuredTimeoutMs);
}
//#endregion
export { isRecoverableTelegramNetworkError as a, isTelegramMisdirectedRequestError as c, isTelegramServerError as d, tagTelegramNetworkError as f, resolveTelegramStartupProbeTimeoutMs as i, isTelegramPollingNetworkError as l, resolveTelegramLongPollTimeoutSeconds as n, isSafeToRetrySendError as o, resolveTelegramRequestTimeoutMs as r, isTelegramClientRejection as s, TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS as t, isTelegramRateLimitError as u };
