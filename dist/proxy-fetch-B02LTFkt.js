import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { r as resolveManagedEnvHttpProxyAgentOptions, t as addActiveManagedProxyTlsOptions } from "./managed-proxy-undici-CxE3Ud0o.js";
import { a as loadUndiciRuntimeDeps } from "./undici-runtime-DWGlO0I7.js";
import { t as normalizeHeadersInitForFetch } from "./fetch-headers-D18pVzIl.js";
//#region src/infra/net/proxy-fetch.ts
const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
function isFormDataLike(value) {
	return typeof value === "object" && value !== null && typeof value.entries === "function" && value[Symbol.toStringTag] === "FormData";
}
function appendFormDataEntry(target, key, value) {
	if (typeof value === "string") {
		target.append(key, value);
		return;
	}
	const fileName = typeof value.name === "string" && value.name.trim() ? value.name : void 0;
	if (fileName) {
		target.append(key, value, fileName);
		return;
	}
	target.append(key, value);
}
function normalizeInitForUndici(init, UndiciFormData) {
	if (!init) return init;
	const normalizedHeaders = normalizeHeadersInitForFetch(init.headers);
	const initWithNormalizedHeaders = normalizedHeaders === init.headers ? init : {
		...init,
		headers: normalizedHeaders
	};
	const body = init.body;
	if (!isFormDataLike(body) || body instanceof UndiciFormData) return initWithNormalizedHeaders;
	const form = new UndiciFormData();
	for (const [key, value] of body.entries()) appendFormDataEntry(form, key, value);
	const headers = new Headers(normalizedHeaders);
	headers.delete("content-length");
	headers.delete("content-type");
	return {
		...initWithNormalizedHeaders,
		headers,
		body: form
	};
}
/**
* Create a fetch function that routes requests through the given HTTP proxy.
* Uses undici's ProxyAgent under the hood.
*/
function makeProxyFetch(proxyUrl) {
	const { ProxyAgent, FormData: UndiciFormData = globalThis.FormData, fetch: undiciFetch } = loadUndiciRuntimeDeps();
	let agent = null;
	const resolveAgent = () => {
		if (!agent) agent = new ProxyAgent(addActiveManagedProxyTlsOptions({ uri: proxyUrl }));
		return agent;
	};
	const proxyFetch = ((input, init) => undiciFetch(input, {
		...normalizeInitForUndici(init, UndiciFormData),
		dispatcher: resolveAgent()
	}));
	Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
		value: proxyUrl,
		enumerable: false,
		configurable: false,
		writable: false
	});
	return proxyFetch;
}
function getProxyUrlFromFetch(fetchImpl) {
	const proxyUrl = fetchImpl?.[PROXY_FETCH_PROXY_URL];
	if (typeof proxyUrl !== "string") return;
	const trimmed = proxyUrl.trim();
	return trimmed ? trimmed : void 0;
}
/**
* Resolve a proxy-aware fetch from standard environment variables.
* Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
* Returns undefined when no proxy is configured.
* Gracefully returns undefined if the proxy URL is malformed.
*/
function resolveProxyFetchFromEnv(env = process.env) {
	const proxyOptions = resolveManagedEnvHttpProxyAgentOptions(env);
	if (!proxyOptions) return;
	try {
		const { EnvHttpProxyAgent, FormData: UndiciFormData = globalThis.FormData, fetch: undiciFetch } = loadUndiciRuntimeDeps();
		const agent = new EnvHttpProxyAgent(proxyOptions);
		return ((input, init) => undiciFetch(input, {
			...normalizeInitForUndici(init, UndiciFormData),
			dispatcher: agent
		}));
	} catch (err) {
		logWarn(`Proxy env var set but agent creation failed — falling back to direct fetch: ${formatErrorMessage(err)}`);
		return;
	}
}
//#endregion
export { resolveProxyFetchFromEnv as i, getProxyUrlFromFetch as n, makeProxyFetch as r, PROXY_FETCH_PROXY_URL as t };
