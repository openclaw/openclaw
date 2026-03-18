import { n as __esmMin } from "./chunk-DORXReHP.js";
//#region src/utils/fetch-timeout.ts
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
var init_fetch_timeout = __esmMin((() => {}));
//#endregion
export { fetchWithTimeout as n, init_fetch_timeout as r, bindAbortRelay as t };
