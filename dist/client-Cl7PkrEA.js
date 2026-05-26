import { p as resolveAmbientNodeProxyAgent, u as readPluginPackageVersion } from "./extension-shared-DSIp8QS_.js";
import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
//#region extensions/feishu/src/client-timeout.ts
/** Default HTTP timeout for Feishu API requests (30 seconds). */
const FEISHU_HTTP_TIMEOUT_MS = 3e4;
const FEISHU_HTTP_TIMEOUT_MAX_MS = 3e5;
const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";
function resolveConfiguredHttpTimeoutMs(creds) {
	const clampTimeout = (value) => {
		return Math.min(Math.max(Math.floor(value), 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
	};
	const fromDirectField = creds.httpTimeoutMs;
	if (typeof fromDirectField === "number" && Number.isFinite(fromDirectField) && fromDirectField > 0) return clampTimeout(fromDirectField);
	const envRaw = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
	if (envRaw) {
		const envValue = Number(envRaw);
		if (Number.isFinite(envValue) && envValue > 0) return clampTimeout(envValue);
	}
	const timeout = creds.config?.httpTimeoutMs;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return FEISHU_HTTP_TIMEOUT_MS;
	return clampTimeout(timeout);
}
//#endregion
//#region extensions/feishu/src/client.ts
const pluginVersion = readPluginPackageVersion({ require: createRequire(import.meta.url) });
const FEISHU_USER_AGENT = `openclaw-feishu-builtin/${pluginVersion}/${process.platform}`;
const FEISHU_WS_CONFIG = {
	PingInterval: 30,
	PingTimeout: 3
};
/** User-Agent header value for all Feishu API requests. */
function getFeishuUserAgent() {
	return FEISHU_USER_AGENT;
}
let feishuClientSdk = {
	AppType: Lark.AppType,
	Client: Lark.Client,
	defaultHttpInstance: Lark.defaultHttpInstance,
	Domain: Lark.Domain,
	EventDispatcher: Lark.EventDispatcher,
	LoggerLevel: Lark.LoggerLevel,
	WSClient: Lark.WSClient
};
{
	const inst = Lark.defaultHttpInstance;
	if (inst.interceptors?.request) {
		inst.interceptors.request.handlers = [];
		inst.interceptors.request.use((req) => {
			const r = req;
			if (r.headers) r.headers["User-Agent"] = getFeishuUserAgent();
			return req;
		});
	}
}
async function getWsProxyAgent() {
	return resolveAmbientNodeProxyAgent();
}
const clientCache = /* @__PURE__ */ new Map();
function resolveDomain(domain) {
	if (domain === "lark") return feishuClientSdk.Domain.Lark;
	if (domain === "feishu" || !domain) return feishuClientSdk.Domain.Feishu;
	return domain.replace(/\/+$/, "");
}
/**
* Create an HTTP instance that delegates to the Lark SDK's default instance
* but injects a default request timeout and User-Agent header to prevent
* indefinite hangs and set a standardized User-Agent per OAPI best practices.
*/
function createTimeoutHttpInstance(defaultTimeoutMs) {
	const base = feishuClientSdk.defaultHttpInstance;
	function injectTimeout(opts) {
		return {
			timeout: defaultTimeoutMs,
			...opts
		};
	}
	return {
		request: (opts) => base.request(injectTimeout(opts)),
		get: (url, opts) => base.get(url, injectTimeout(opts)),
		post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
		put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
		patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
		delete: (url, opts) => base.delete(url, injectTimeout(opts)),
		head: (url, opts) => base.head(url, injectTimeout(opts)),
		options: (url, opts) => base.options(url, injectTimeout(opts))
	};
}
/**
* Create or get a cached Feishu client for an account.
* Accepts any object with appId, appSecret, and optional domain/accountId.
*/
function createFeishuClient(creds) {
	const { accountId = "default", appId, appSecret, domain } = creds;
	const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);
	if (!appId || !appSecret) throw new Error(`Feishu credentials not configured for account "${accountId}"`);
	const cached = clientCache.get(accountId);
	if (cached && cached.config.appId === appId && cached.config.appSecret === appSecret && cached.config.domain === domain && cached.config.httpTimeoutMs === defaultHttpTimeoutMs) return cached.client;
	const client = new feishuClientSdk.Client({
		appId,
		appSecret,
		appType: feishuClientSdk.AppType.SelfBuild,
		domain: resolveDomain(domain),
		httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs)
	});
	clientCache.set(accountId, {
		client,
		config: {
			appId,
			appSecret,
			domain,
			httpTimeoutMs: defaultHttpTimeoutMs
		}
	});
	return client;
}
/**
* Create a Feishu WebSocket client for an account.
* Note: WSClient is not cached since each call creates a new connection.
*/
async function createFeishuWSClient(account, callbacks = {}) {
	const { accountId, appId, appSecret, domain } = account;
	if (!appId || !appSecret) throw new Error(`Feishu credentials not configured for account "${accountId}"`);
	const agent = await getWsProxyAgent();
	return new feishuClientSdk.WSClient({
		appId,
		appSecret,
		domain: resolveDomain(domain),
		...callbacks,
		loggerLevel: feishuClientSdk.LoggerLevel.info,
		wsConfig: FEISHU_WS_CONFIG,
		...agent ? { agent } : {}
	});
}
/**
* Create an event dispatcher for an account.
*/
function createEventDispatcher(account) {
	return new feishuClientSdk.EventDispatcher({
		encryptKey: account.encryptKey,
		verificationToken: account.verificationToken
	});
}
//#endregion
export { getFeishuUserAgent as a, FEISHU_HTTP_TIMEOUT_MAX_MS as c, createFeishuWSClient as i, FEISHU_HTTP_TIMEOUT_MS as l, createEventDispatcher as n, pluginVersion as o, createFeishuClient as r, FEISHU_HTTP_TIMEOUT_ENV_VAR as s, FEISHU_USER_AGENT as t };
