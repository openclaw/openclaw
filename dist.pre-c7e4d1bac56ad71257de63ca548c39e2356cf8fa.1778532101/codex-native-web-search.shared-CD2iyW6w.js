import { c as isRecord } from "./utils-D5swhEXt.js";
//#region src/agents/codex-native-web-search.shared.ts
function normalizeAllowedDomains(value) {
	if (!Array.isArray(value)) return;
	const deduped = [...new Set(value.map((entry) => typeof entry === "string" ? entry.trim() : null).filter((entry) => Boolean(entry)))];
	return deduped.length > 0 ? deduped : void 0;
}
function normalizeContextSize(value) {
	if (value === "low" || value === "medium" || value === "high") return value;
}
function normalizeMode(value) {
	return value === "live" ? "live" : "cached";
}
function normalizeUserLocation(value) {
	if (!isRecord(value)) return;
	const location = {
		country: typeof value.country === "string" ? value.country.trim() || void 0 : void 0,
		region: typeof value.region === "string" ? value.region.trim() || void 0 : void 0,
		city: typeof value.city === "string" ? value.city.trim() || void 0 : void 0,
		timezone: typeof value.timezone === "string" ? value.timezone.trim() || void 0 : void 0
	};
	return location.country || location.region || location.city || location.timezone ? location : void 0;
}
function resolveCodexNativeWebSearchConfig(config) {
	const nativeConfig = config?.tools?.web?.search?.openaiCodex;
	return {
		enabled: nativeConfig?.enabled === true,
		mode: normalizeMode(nativeConfig?.mode),
		allowedDomains: normalizeAllowedDomains(nativeConfig?.allowedDomains),
		contextSize: normalizeContextSize(nativeConfig?.contextSize),
		userLocation: normalizeUserLocation(nativeConfig?.userLocation)
	};
}
function describeCodexNativeWebSearch(config) {
	if (config?.tools?.web?.search?.enabled === false) return;
	const nativeConfig = resolveCodexNativeWebSearchConfig(config);
	if (!nativeConfig.enabled) return;
	return `Codex native search: ${nativeConfig.mode} for Codex-capable models`;
}
//#endregion
export { resolveCodexNativeWebSearchConfig as n, describeCodexNativeWebSearch as t };
