//#region src/infra/net/proxy-env.ts
const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy"
];
function hasProxyEnvConfigured(env = process.env) {
	for (const key of PROXY_ENV_KEYS) {
		const value = env[key];
		if (typeof value === "string" && value.trim().length > 0) return true;
	}
	return false;
}
function normalizeProxyEnvValue(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
/**
* Match undici EnvHttpProxyAgent semantics for env-based HTTP/S proxy selection:
* - lower-case vars take precedence over upper-case
* - HTTPS requests prefer https_proxy/HTTPS_PROXY, then fall back to http_proxy/HTTP_PROXY
* - ALL_PROXY is ignored by EnvHttpProxyAgent
*/
function resolveEnvHttpProxyUrl(protocol, env = process.env) {
	const lowerHttpProxy = normalizeProxyEnvValue(env.http_proxy);
	const lowerHttpsProxy = normalizeProxyEnvValue(env.https_proxy);
	const httpProxy = lowerHttpProxy !== void 0 ? lowerHttpProxy : normalizeProxyEnvValue(env.HTTP_PROXY);
	const httpsProxy = lowerHttpsProxy !== void 0 ? lowerHttpsProxy : normalizeProxyEnvValue(env.HTTPS_PROXY);
	if (protocol === "https") return httpsProxy ?? httpProxy ?? void 0;
	return httpProxy ?? void 0;
}
function hasEnvHttpProxyConfigured(protocol = "https", env = process.env) {
	return resolveEnvHttpProxyUrl(protocol, env) !== void 0;
}
//#endregion
export { hasProxyEnvConfigured as n, resolveEnvHttpProxyUrl as r, hasEnvHttpProxyConfigured as t };
