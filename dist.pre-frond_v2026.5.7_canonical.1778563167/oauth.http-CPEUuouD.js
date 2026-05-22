import { n as fetchWithSsrFGuard } from "./fetch-guard-BWAGy4Ih.js";
import "./ssrf-runtime-BxiaPFE4.js";
import { a as DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared-i9wwnXJs.js";
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
