import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";

//#region src/utils/fetch-timeout.ts
var fetch_timeout_exports = /* @__PURE__ */ __exportAll({
	bindAbortRelay: () => bindAbortRelay,
	fetchWithTimeout: () => fetchWithTimeout
});
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
	const controller = new AbortController();
	const timer = setTimeout(controller.abort.bind(controller), Math.max(1, timeoutMs));
	try {
		return await fetchFn(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
export { fetchWithTimeout as n, fetch_timeout_exports as r, bindAbortRelay as t };