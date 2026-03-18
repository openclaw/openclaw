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
//#region src/infra/fetch.ts
function withDuplex(init, input) {
	const hasInitBody = init?.body != null;
	const hasRequestBody = !hasInitBody && typeof Request !== "undefined" && input instanceof Request && input.body != null;
	if (!hasInitBody && !hasRequestBody) return init;
	if (init && "duplex" in init) return init;
	return init ? {
		...init,
		duplex: "half"
	} : { duplex: "half" };
}
function wrapFetchWithAbortSignal(fetchImpl) {
	if (fetchImpl[wrapFetchWithAbortSignalMarker]) return fetchImpl;
	const wrapped = ((input, init) => {
		const patchedInit = withDuplex(init, input);
		const signal = patchedInit?.signal;
		if (!signal) return fetchImpl(input, patchedInit);
		if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) return fetchImpl(input, patchedInit);
		if (typeof AbortController === "undefined") return fetchImpl(input, patchedInit);
		if (typeof signal.addEventListener !== "function") return fetchImpl(input, patchedInit);
		const controller = new AbortController();
		const onAbort = bindAbortRelay(controller);
		let listenerAttached = false;
		if (signal.aborted) controller.abort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			listenerAttached = true;
		}
		const cleanup = () => {
			if (!listenerAttached || typeof signal.removeEventListener !== "function") return;
			listenerAttached = false;
			try {
				signal.removeEventListener("abort", onAbort);
			} catch {}
		};
		try {
			return fetchImpl(input, {
				...patchedInit,
				signal: controller.signal
			}).finally(cleanup);
		} catch (error) {
			cleanup();
			throw error;
		}
	});
	const wrappedFetch = Object.assign(wrapped, fetchImpl);
	const fetchWithPreconnect = fetchImpl;
	wrappedFetch.preconnect = typeof fetchWithPreconnect.preconnect === "function" ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect) : () => {};
	Object.defineProperty(wrappedFetch, wrapFetchWithAbortSignalMarker, {
		value: true,
		enumerable: false,
		configurable: false,
		writable: false
	});
	return wrappedFetch;
}
function resolveFetch(fetchImpl) {
	const resolved = fetchImpl ?? globalThis.fetch;
	if (!resolved) return;
	return wrapFetchWithAbortSignal(resolved);
}
var wrapFetchWithAbortSignalMarker;
var init_fetch = __esmMin((() => {
	init_fetch_timeout();
	wrapFetchWithAbortSignalMarker = Symbol.for("openclaw.fetch.abort-signal-wrapped");
}));
//#endregion
export { fetchWithTimeout as a, bindAbortRelay as i, resolveFetch as n, init_fetch_timeout as o, wrapFetchWithAbortSignal as r, init_fetch as t };
