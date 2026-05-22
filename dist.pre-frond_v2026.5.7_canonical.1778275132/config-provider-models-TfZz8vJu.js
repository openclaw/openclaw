import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
//#region src/media-understanding/provider-id.ts
function normalizeMediaProviderId(id) {
	const normalized = normalizeProviderId(id);
	if (normalized === "gemini") return "google";
	return normalized;
}
//#endregion
//#region src/media-understanding/config-provider-models.ts
function hasImageCapableModel(providerCfg) {
	return (providerCfg.models ?? []).some((model) => Array.isArray(model?.input) && model.input.includes("image"));
}
function resolveImageCapableConfigProviderIds(cfg) {
	const configProviders = cfg?.models?.providers;
	if (!configProviders || typeof configProviders !== "object") return [];
	const providerIds = [];
	for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
		if (!providerKey?.trim() || !hasImageCapableModel(providerCfg)) continue;
		providerIds.push(normalizeMediaProviderId(providerKey));
	}
	return providerIds;
}
//#endregion
export { normalizeMediaProviderId as n, resolveImageCapableConfigProviderIds as t };
