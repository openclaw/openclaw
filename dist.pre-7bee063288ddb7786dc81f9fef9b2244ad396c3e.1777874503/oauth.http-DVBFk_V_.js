import { n as fetchWithSsrFGuard } from "./fetch-guard-C2Af5kcY.js";
import "./ssrf-runtime-B3HHI4NS.js";
import { a as DEFAULT_FETCH_TIMEOUT_MS } from "./oauth.shared-DtCLKMb0.js";
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
