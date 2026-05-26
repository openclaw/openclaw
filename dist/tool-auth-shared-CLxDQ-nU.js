import { d as normalizeSecretInputString, h as resolveSecretInputString, o as coerceSecretRef } from "./types.secrets-BxqheYvy.js";
import { h as resolveNonEnvSecretRefApiKeyMarker } from "./model-auth-markers-UDEQVW7W.js";
import { p as readProviderEnvValue } from "./web-search-provider-common-CHdvpLZ1.js";
import "./provider-auth-D5QGE8z6.js";
import "./secret-input-DlbCRffO.js";
import { i as canResolveEnvSecretRefInReadOnlyPath } from "./extension-shared-BznPIa-o.js";
import { i as resolveProviderWebSearchPluginConfig } from "./web-search-provider-config-BmnIzf0a.js";
import "./provider-web-search-D2KY-StD.js";
//#region extensions/xai/src/tool-auth-shared.ts
const XAI_API_KEY_ENV_VAR = "XAI_API_KEY";
const XAI_PROVIDER_ID = "xai";
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
function resolveConfiguredXaiToolApiKeyResult(params) {
	const runtimePlugin = readPluginXaiWebSearchApiKeyResult(params.runtimeConfig);
	if (runtimePlugin.status === "available" || runtimePlugin.status === "blocked") return runtimePlugin;
	const runtimeLegacy = readLegacyGrokApiKeyResult(params.runtimeConfig);
	if (runtimeLegacy.status === "available" || runtimeLegacy.status === "blocked") return runtimeLegacy;
	const sourcePlugin = readPluginXaiWebSearchApiKeyResult(params.sourceConfig);
	if (sourcePlugin.status === "available" || sourcePlugin.status === "blocked") return sourcePlugin;
	const sourceLegacy = readLegacyGrokApiKeyResult(params.sourceConfig);
	if (sourceLegacy.status === "available" || sourceLegacy.status === "blocked") return sourceLegacy;
	return { status: "missing" };
}
function hasXaiAuthProfile(auth) {
	return auth?.hasAuthForProvider?.(XAI_PROVIDER_ID) === true;
}
async function resolveXaiAuthProfileApiKey(auth) {
	return normalizeSecretInputString(await auth?.resolveApiKeyForProvider?.(XAI_PROVIDER_ID));
}
function resolveFallbackXaiAuth(cfg) {
	const pluginApiKey = readConfiguredOrManagedApiKey(resolveProviderWebSearchPluginConfig(cfg, "xai")?.apiKey);
	if (pluginApiKey) return {
		apiKey: pluginApiKey,
		source: "plugins.entries.xai.config.webSearch.apiKey"
	};
	return readLegacyGrokFallbackAuth(cfg);
}
async function resolveXaiToolApiKeyWithAuth(params) {
	const configured = resolveConfiguredXaiToolApiKeyResult(params);
	if (configured.status === "available") return configured.value;
	if (configured.status === "blocked") return;
	return await resolveXaiAuthProfileApiKey(params.auth) ?? readProviderEnvValue([XAI_API_KEY_ENV_VAR]);
}
function isXaiToolEnabled(params) {
	if (params.enabled === false) return false;
	const configured = resolveConfiguredXaiToolApiKeyResult(params);
	if (configured.status === "available") return true;
	if (configured.status === "blocked") return false;
	return hasXaiAuthProfile(params.auth) || Boolean(readProviderEnvValue([XAI_API_KEY_ENV_VAR]));
}
//#endregion
export { resolveFallbackXaiAuth as n, resolveXaiToolApiKeyWithAuth as r, isXaiToolEnabled as t };
