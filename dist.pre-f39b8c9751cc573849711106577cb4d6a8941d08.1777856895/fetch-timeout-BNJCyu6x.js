import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
//#region src/utils/fetch-timeout.ts
const log = createSubsystemLogger("fetch-timeout");
const LOG_URL_MAX_CHARS = 500;
const URL_SECRET_SUFFIX_PATTERN = /[?#]/;
/**
* Relay abort without forwarding the Event argument as the abort reason.
* Using .bind() avoids closure scope capture (memory leak prevention).
*/
function relayAbort() {
	this.abort();
}
/** Returns a bound abort relay for use as an event listener. */
function bindAbortRelay(controller) {
	return relayAbort.bind(controller);
}
function sanitizeTimeoutLogUrl(rawUrl) {
	const trimmed = rawUrl?.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		const value = parsed.toString();
		return value.length > LOG_URL_MAX_CHARS ? `${value.slice(0, LOG_URL_MAX_CHARS)}...` : value;
	} catch {
		const cleaned = (trimmed.split(URL_SECRET_SUFFIX_PATTERN, 1)[0] ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
		if (!cleaned) return;
		return cleaned.length > LOG_URL_MAX_CHARS ? `${cleaned.slice(0, LOG_URL_MAX_CHARS)}...` : cleaned;
	}
}
function abortDueToTimeout(controller, timeoutMs, startedAtMs, operation, url) {
	if (controller.signal.aborted) return;
	const sanitizedUrl = sanitizeTimeoutLogUrl(url);
	const elapsedMs = Math.max(0, Date.now() - startedAtMs);
	const consoleMessage = [
		`fetch timeout after ${timeoutMs}ms`,
		`(elapsed ${elapsedMs}ms)`,
		operation ? `operation=${operation}` : null,
		sanitizedUrl ? `url=${sanitizedUrl}` : null
	].filter((part) => Boolean(part)).join(" ");
	log.warn("fetch timeout reached; aborting operation", {
		timeoutMs,
		elapsedMs,
		consoleMessage,
		...operation ? { operation } : {},
		...sanitizedUrl ? { url: sanitizedUrl } : {}
	});
	controller.abort();
}
function buildTimeoutAbortSignal(params) {
	const { timeoutMs, signal } = params;
	if (!timeoutMs && !signal) return {
		signal: void 0,
		cleanup: () => {}
	};
	if (!timeoutMs) return {
		signal,
		cleanup: () => {}
	};
	const controller = new AbortController();
	const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
	const timeoutId = setTimeout(abortDueToTimeout, normalizedTimeoutMs, controller, normalizedTimeoutMs, Date.now(), params.operation, params.url);
	const onAbort = bindAbortRelay(controller);
	if (signal) if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	};
}
/**
* Fetch wrapper that adds timeout support via AbortController.
*
* @param url - The URL to fetch
* @param init - RequestInit options (headers, method, body, etc.)
* @param timeoutMs - Timeout in milliseconds
* @param fetchFn - The fetch implementation to use (defaults to global fetch)
* @returns The fetch Response
* @throws AbortError if the request times out
*/
async function fetchWithTimeout(url, init, timeoutMs, fetchFn = fetch) {
	const { signal, cleanup } = buildTimeoutAbortSignal({
		timeoutMs: Math.max(1, timeoutMs),
		operation: "fetchWithTimeout",
		url
	});
	try {
		return await fetchFn(url, {
			...init,
			signal
		});
	} finally {
		cleanup();
	}
}
//#endregion
export { buildTimeoutAbortSignal as n, fetchWithTimeout as r, bindAbortRelay as t };
