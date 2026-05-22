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
function resolveEnvAllProxyUrl(env) {
	const lowerAllProxy = normalizeProxyEnvValue(env.all_proxy);
	return (lowerAllProxy !== void 0 ? lowerAllProxy : normalizeProxyEnvValue(env.ALL_PROXY)) ?? void 0;
}
/**
* Build explicit options for undici's EnvHttpProxyAgent.
*
* EnvHttpProxyAgent does not read ALL_PROXY itself, but it accepts explicit
* HTTP/HTTPS proxy overrides. Keep this helper separate from the
* HTTP(S)-only URL helpers so SSRF trusted-env proxy gates do not widen.
*/
function resolveEnvHttpProxyAgentOptions(env = process.env) {
	const allProxy = resolveEnvAllProxyUrl(env);
	const httpProxy = resolveEnvHttpProxyUrl("http", env) ?? allProxy;
	const httpsProxy = resolveEnvHttpProxyUrl("https", env) ?? httpProxy;
	const options = {
		...httpProxy ? { httpProxy } : {},
		...httpsProxy ? { httpsProxy } : {}
	};
	return options.httpProxy || options.httpsProxy ? options : void 0;
}
function hasEnvHttpProxyAgentConfigured(env = process.env) {
	return resolveEnvHttpProxyAgentOptions(env) !== void 0;
}
function shouldUseEnvHttpProxyForUrl(targetUrl, env = process.env) {
	let protocol;
	try {
		const parsed = new URL(targetUrl);
		if (parsed.protocol === "http:") protocol = "http";
		else if (parsed.protocol === "https:") protocol = "https";
		else return false;
	} catch {
		return false;
	}
	return hasEnvHttpProxyConfigured(protocol, env) && !matchesNoProxy(targetUrl, env);
}
/**
* Check whether a target URL should bypass the HTTP proxy per NO_PROXY env var.
*
* Mirrors undici EnvHttpProxyAgent semantics
* (`undici/lib/dispatcher/env-http-proxy-agent.js`):
* - Entries separated by commas OR whitespace (undici splits on `/[,\s]/`)
* - Case-insensitive
* - Empty or missing → no bypass
* - Bare `*` value → bypass everything
* - Exact hostname match
* - Leading-dot match (`.example.com` matches `foo.example.com`)
* - Leading `*.` wildcard match (`*.example.com` matches `foo.example.com`);
*   undici normalizes via `.replace(/^\*?\./, '')`, so the bare domain also
*   matches (kept in sync with that behavior)
* - Subdomain suffix match (`openai.com` matches `api.openai.com`)
* - Optional `:port` suffix; when present, must match target port
* - IPv6 literals in bracketed form (`[::1]`)
*
* Undici does not export its matcher, so this is a targeted reimplementation
* kept in sync with the upstream file above. Paired with
* `hasEnvHttpProxyConfigured` this gates the trusted-env-proxy auto-upgrade
* in provider HTTP helpers; see openclaw#64974 review thread on NO_PROXY
* SSRF bypass.
*/
function matchesNoProxy(targetUrl, env = process.env) {
	const raw = normalizeProxyEnvValue(env.no_proxy) ?? normalizeProxyEnvValue(env.NO_PROXY);
	if (!raw) return false;
	let parsed;
	try {
		parsed = new URL(targetUrl);
	} catch {
		return false;
	}
	const targetHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!targetHost) return false;
	if (raw === "*") return true;
	const targetPort = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
	for (const rawEntry of raw.split(/[,\s]/)) {
		const entry = rawEntry.trim().toLowerCase();
		if (!entry) continue;
		let entryHost;
		let entryPort;
		if (entry.startsWith("[")) {
			const m = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
			if (!m) continue;
			entryHost = m[1];
			entryPort = m[2];
		} else {
			const colonIdx = entry.lastIndexOf(":");
			if (colonIdx > 0 && /^\d+$/.test(entry.slice(colonIdx + 1))) {
				entryHost = entry.slice(0, colonIdx);
				entryPort = entry.slice(colonIdx + 1);
			} else entryHost = entry;
		}
		if (entryPort && entryPort !== targetPort) continue;
		const normalizedEntry = entryHost.replace(/^\*\./, "").replace(/^\./, "");
		if (!normalizedEntry || normalizedEntry === "*") continue;
		if (targetHost === normalizedEntry) return true;
		if (targetHost.endsWith("." + normalizedEntry)) return true;
	}
	return false;
}
//#endregion
export { matchesNoProxy as a, shouldUseEnvHttpProxyForUrl as c, hasProxyEnvConfigured as i, hasEnvHttpProxyAgentConfigured as n, resolveEnvHttpProxyAgentOptions as o, hasEnvHttpProxyConfigured as r, resolveEnvHttpProxyUrl as s, PROXY_ENV_KEYS as t };
