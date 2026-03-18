import { n as __esmMin } from "./chunk-DORXReHP.js";
import { r as init_fetch_timeout, t as bindAbortRelay } from "./fetch-timeout-DtFP6dT0.js";
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
export { resolveFetch as n, wrapFetchWithAbortSignal as r, init_fetch as t };
