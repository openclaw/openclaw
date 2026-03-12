import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { ProxyAgent, fetch } from "undici";

//#region src/telegram/proxy.ts
var proxy_exports = /* @__PURE__ */ __exportAll({ makeProxyFetch: () => makeProxyFetch });
function makeProxyFetch(proxyUrl) {
	const agent = new ProxyAgent(proxyUrl);
	const fetcher = ((input, init) => fetch(input, {
		...init,
		dispatcher: agent
	}));
	return fetcher;
}

//#endregion
export { proxy_exports as n, makeProxyFetch as t };