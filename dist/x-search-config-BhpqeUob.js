import { c as isRecord } from "./utils-sBTEdeml.js";
import "./tool-config-shared-Dk_VjbjJ.js";
//#region extensions/xai/src/x-search-config.ts
function cloneRecord(value) {
	if (!value) return value;
	return { ...value };
}
function resolveLegacyXSearchConfig(config) {
	const xSearch = (config?.tools?.web)?.x_search;
	return isRecord(xSearch) ? cloneRecord(xSearch) : void 0;
}
function resolvePluginXSearchConfig(config) {
	const pluginConfig = config?.plugins?.entries?.xai?.config;
	if (!isRecord(pluginConfig?.xSearch)) return;
	return cloneRecord(pluginConfig.xSearch);
}
function resolveLegacyGrokWebSearchConfig(config) {
	const search = (config?.tools?.web)?.search;
	if (!isRecord(search) || !isRecord(search.grok)) return;
	return cloneRecord(search.grok);
}
function resolvePluginWebSearchConfig(config) {
	const pluginConfig = config?.plugins?.entries?.xai?.config;
	if (!isRecord(pluginConfig?.webSearch)) return;
	return cloneRecord(pluginConfig.webSearch);
}
function baseUrlFallback(config) {
	return typeof config?.baseUrl === "string" && config.baseUrl.trim() ? { baseUrl: config.baseUrl } : void 0;
}
function resolveEffectiveXSearchConfig(config) {
	const legacyGrokBaseUrl = baseUrlFallback(resolveLegacyGrokWebSearchConfig(config));
	const pluginWebSearchBaseUrl = baseUrlFallback(resolvePluginWebSearchConfig(config));
	const legacy = resolveLegacyXSearchConfig(config);
	const pluginOwned = resolvePluginXSearchConfig(config);
	const merged = {
		...legacyGrokBaseUrl,
		...pluginWebSearchBaseUrl,
		...legacy,
		...pluginOwned
	};
	if (Object.keys(merged).length === 0) return;
	return merged;
}
function setPluginXSearchConfigValue(configTarget, key, value) {
	const plugins = configTarget.plugins ??= {};
	const entries = plugins.entries ??= {};
	const entry = entries.xai ??= {};
	const config = entry.config ??= {};
	const xSearch = config.xSearch ??= {};
	xSearch[key] = value;
}
//#endregion
export { setPluginXSearchConfigValue as n, resolveEffectiveXSearchConfig as t };
