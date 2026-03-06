import { i as logWarn } from "./logger-Dv6Sz3FH.js";
import { EnvHttpProxyAgent, ProxyAgent, fetch } from "undici";

//#region src/infra/net/proxy-fetch.ts
/**
* Create a fetch function that routes requests through the given HTTP proxy.
* Uses undici's ProxyAgent under the hood.
*/
function makeProxyFetch(proxyUrl) {
	const agent = new ProxyAgent(proxyUrl);
	return ((input, init) => fetch(input, {
		...init,
		dispatcher: agent
	}));
}
/**
* Resolve a proxy-aware fetch from standard environment variables
* (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
* Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
* Returns undefined when no proxy is configured.
* Gracefully returns undefined if the proxy URL is malformed.
*/
function resolveProxyFetchFromEnv() {
	if (!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy)?.trim()) return;
	try {
		const agent = new EnvHttpProxyAgent();
		return ((input, init) => fetch(input, {
			...init,
			dispatcher: agent
		}));
	} catch (err) {
		logWarn(`Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
}

//#endregion
export { resolveProxyFetchFromEnv as n, makeProxyFetch as t };