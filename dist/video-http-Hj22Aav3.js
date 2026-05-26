import { o as fetchWithTimeoutGuarded } from "./shared-D8kCtbT2.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/openrouter/video-http.ts
function headersForOpenRouterGet(url, baseUrl, requestHeaders) {
	try {
		if (new URL(url).origin !== new URL(baseUrl).origin) return new Headers();
	} catch {
		return new Headers();
	}
	const headers = new Headers(requestHeaders);
	headers.delete("content-type");
	return headers;
}
function resolveOpenRouterVideoUrl(url, baseUrl) {
	return new URL(url, `${baseUrl}/`).href;
}
async function fetchOpenRouterVideoGet(params) {
	const url = resolveOpenRouterVideoUrl(params.url, params.baseUrl);
	return await fetchWithTimeoutGuarded(url, {
		method: "GET",
		headers: headersForOpenRouterGet(url, params.baseUrl, params.headers)
	}, params.timeoutMs, fetch, {
		...params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {},
		...params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {},
		auditContext: params.auditContext
	});
}
//#endregion
export { resolveOpenRouterVideoUrl as n, fetchOpenRouterVideoGet as t };
