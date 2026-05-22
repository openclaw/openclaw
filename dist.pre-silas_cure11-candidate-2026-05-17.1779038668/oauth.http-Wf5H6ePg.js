import { n as fetchWithSsrFGuard } from "./fetch-guard-DAbNVyC5.js";
import "./ssrf-runtime-Cvk-tl6n.js";
import { a as DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared-BV6-IEsl.js";
//#region extensions/google/oauth.http.ts
async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init,
		timeoutMs
	});
	try {
		const body = await response.arrayBuffer();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	} finally {
		await release();
	}
}
//#endregion
export { fetchWithTimeout as t };
