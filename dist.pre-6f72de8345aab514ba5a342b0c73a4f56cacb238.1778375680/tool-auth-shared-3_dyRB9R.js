import { d as normalizeSecretInputString, h as resolveSecretInputString, o as coerceSecretRef } from "./types.secrets-DYAh0rlj.js";
import { h as resolveNonEnvSecretRefApiKeyMarker } from "./model-auth-markers-ZhozO8kc.js";
import { p as readProviderEnvValue } from "./web-search-provider-common-9wZEsKDV.js";
import "./provider-auth-Bngy0QLv.js";
import "./secret-input-BcbJzr_x.js";
import { i as canResolveEnvSecretRefInReadOnlyPath } from "./extension-shared-CVbE9G6s.js";
import { i as resolveProviderWebSearchPluginConfig } from "./web-search-provider-config-BUMApiwS.js";
import "./provider-web-search-D32k1uCd.js";
//#region extensions/xai/src/tool-auth-shared.ts
const XAI_API_KEY_ENV_VAR = "XAI_API_KEY";
function readConfiguredOrManagedApiKey(value) {
	const literal = normalizeSecretInputString(value);
	if (literal) return literal;
	const ref = coerceSecretRef(value);
	return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : void 0;
}
function readLegacyGrokFallbackAuth(cfg) {
	const search = cfg?.tools?.web?.search;
	if (!search || typeof search !== "object") return;
	const grok = search.grok;
	const apiKey = readConfiguredOrManagedApiKey(grok && typeof grok === "object" ? grok.apiKey : void 0);
	return apiKey ? {
		apiKey,
		source: "tools.web.search.grok.apiKey"
	} : void 0;
}
function readConfiguredRuntimeApiKey(value, path, cfg) {
	const resolved = resolveSecretInputString({
		value,
		path,
		defaults: cfg?.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status === "available") return {
		status: "available",
		value: resolved.value
	};
	if (resolved.status === "missing") return { status: "missing" };
	if (resolved.ref.source !== "env") return { status: "blocked" };
	const envVarName = resolved.ref.id.trim();
	if (envVarName !== XAI_API_KEY_ENV_VAR) return { status: "blocked" };
	if (!canResolveEnvSecretRefInReadOnlyPath({
		cfg,
		provider: resolved.ref.provider,
		id: envVarName
	})) return { status: "blocked" };
	const envValue = normalizeSecretInputString(process.env[envVarName]);
	return envValue ? {
		status: "available",
		value: envValue
	} : { status: "missing" };
}
function readLegacyGrokApiKeyResult(cfg) {
	const search = cfg?.tools?.web?.search;
	if (!search || typeof search !== "object") return { status: "missing" };
	const grok = search.grok;
	return readConfiguredRuntimeApiKey(grok && typeof grok === "object" ? grok.apiKey : void 0, "tools.web.search.grok.apiKey", cfg);
}
function readPluginXaiWebSearchApiKeyResult(cfg) {
	return readConfiguredRuntimeApiKey(resolveProviderWebSearchPluginConfig(cfg, "xai")?.apiKey, "plugins.entries.xai.config.webSearch.apiKey", cfg);
}
function resolveFallbackXaiAuth(cfg) {
	const pluginApiKey = readConfiguredOrManagedApiKey(resolveProviderWebSearchPluginConfig(cfg, "xai")?.apiKey);
	if (pluginApiKey) return {
		apiKey: pluginApiKey,
		source: "plugins.entries.xai.config.webSearch.apiKey"
	};
	return readLegacyGrokFallbackAuth(cfg);
}
function resolveXaiToolApiKey(params) {
	const runtimePlugin = readPluginXaiWebSearchApiKeyResult(params.runtimeConfig);
	if (runtimePlugin.status === "available") return runtimePlugin.value;
	if (runtimePlugin.status === "blocked") return;
	const runtimeLegacy = readLegacyGrokApiKeyResult(params.runtimeConfig);
	if (runtimeLegacy.status === "available") return runtimeLegacy.value;
	if (runtimeLegacy.status === "blocked") return;
	const sourcePlugin = readPluginXaiWebSearchApiKeyResult(params.sourceConfig);
	if (sourcePlugin.status === "available") return sourcePlugin.value;
	if (sourcePlugin.status === "blocked") return;
	const sourceLegacy = readLegacyGrokApiKeyResult(params.sourceConfig);
	if (sourceLegacy.status === "available") return sourceLegacy.value;
	if (sourceLegacy.status === "blocked") return;
	return readProviderEnvValue([XAI_API_KEY_ENV_VAR]);
}
function isXaiToolEnabled(params) {
	if (params.enabled === false) return false;
	return Boolean(resolveXaiToolApiKey(params));
}
//#endregion
export { resolveFallbackXaiAuth as n, resolveXaiToolApiKey as r, isXaiToolEnabled as t };
