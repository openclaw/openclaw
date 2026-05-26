import { s as resolveEnvHttpProxyUrl } from "./proxy-env-Bl2eQt0u.js";
import "./fetch-runtime-Byqsj2nO.js";
import { createHash } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebClient } from "@slack/web-api";
//#region extensions/slack/src/client-options.ts
const SLACK_DEFAULT_RETRY_OPTIONS = {
	retries: 2,
	factor: 2,
	minTimeout: 500,
	maxTimeout: 3e3,
	randomize: true
};
const SLACK_WRITE_RETRY_OPTIONS = { retries: 0 };
/**
* Check whether a hostname is excluded from proxying by `NO_PROXY` / `no_proxy`.
* Supports comma-separated entries with optional leading dots (e.g. `.slack.com`).
*/
function isHostExcludedByNoProxy(hostname, env = process.env) {
	const raw = env.no_proxy ?? env.NO_PROXY;
	if (!raw) return false;
	const entries = raw.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
	const lower = hostname.toLowerCase();
	for (const entry of entries) {
		if (entry === "*") return true;
		const bare = entry.startsWith("*.") ? entry.slice(2) : entry.startsWith(".") ? entry.slice(1) : entry;
		if (lower === bare || lower.endsWith(`.${bare}`)) return true;
	}
	return false;
}
/**
* Build an HTTPS proxy agent from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
* for use as the `agent` option in Slack WebClient and Socket Mode connections.
*
* When set, this agent is forwarded through @slack/bolt -> @slack/socket-mode ->
* SlackWebSocket as the `httpAgent`, which the `ws` library uses to tunnel the
* WebSocket upgrade request through the proxy. This fixes Socket Mode in
* environments where outbound traffic must go through an HTTP CONNECT proxy.
*
* Respects `NO_PROXY` / `no_proxy`; if `*.slack.com` (or a matching pattern)
* appears in the exclusion list, returns `undefined` so the connection is direct.
*
* Returns `undefined` when no proxy env var is configured or when Slack hosts
* are excluded by `NO_PROXY`.
*/
function resolveSlackProxyAgent() {
	const proxyUrl = resolveEnvHttpProxyUrl("https");
	if (!proxyUrl) return;
	if (isHostExcludedByNoProxy("slack.com")) return;
	try {
		return new HttpsProxyAgent(proxyUrl);
	} catch {
		return;
	}
}
function resolveSlackWebClientOptions(options = {}) {
	return {
		...options,
		agent: options.agent ?? resolveSlackProxyAgent(),
		retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS
	};
}
function resolveSlackWriteClientOptions(options = {}) {
	return {
		...options,
		agent: options.agent ?? resolveSlackProxyAgent(),
		retryConfig: options.retryConfig ?? SLACK_WRITE_RETRY_OPTIONS,
		maxRequestConcurrency: options.maxRequestConcurrency ?? 1
	};
}
//#endregion
//#region extensions/slack/src/client.ts
const SLACK_WRITE_CLIENT_CACHE_MAX = 32;
const slackWriteClientCache = /* @__PURE__ */ new Map();
function createSlackWebClient(token, options = {}) {
	return new WebClient(token, resolveSlackWebClientOptions(options));
}
function createSlackWriteClient(token, options = {}) {
	return new WebClient(token, resolveSlackWriteClientOptions(options));
}
function createSlackTokenCacheKey(token) {
	return `sha256:${createHash("sha256").update(token).digest("base64url")}`;
}
function getSlackWriteClient(token) {
	const tokenKey = createSlackTokenCacheKey(token);
	const cached = slackWriteClientCache.get(tokenKey);
	if (cached) {
		slackWriteClientCache.delete(tokenKey);
		slackWriteClientCache.set(tokenKey, cached);
		return cached;
	}
	const client = createSlackWriteClient(token);
	if (slackWriteClientCache.size >= SLACK_WRITE_CLIENT_CACHE_MAX) {
		const oldestTokenKey = slackWriteClientCache.keys().next().value;
		if (oldestTokenKey) slackWriteClientCache.delete(oldestTokenKey);
	}
	slackWriteClientCache.set(tokenKey, client);
	return client;
}
function clearSlackWriteClientCacheForTest() {
	slackWriteClientCache.clear();
}
//#endregion
export { getSlackWriteClient as a, resolveSlackWebClientOptions as c, createSlackWriteClient as i, resolveSlackWriteClientOptions as l, createSlackTokenCacheKey as n, SLACK_DEFAULT_RETRY_OPTIONS as o, createSlackWebClient as r, SLACK_WRITE_RETRY_OPTIONS as s, clearSlackWriteClientCacheForTest as t };
