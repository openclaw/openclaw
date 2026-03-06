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

//#endregion
export { makeProxyFetch as t };