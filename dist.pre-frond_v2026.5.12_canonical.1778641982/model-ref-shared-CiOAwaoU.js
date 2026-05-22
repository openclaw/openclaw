import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import { t as normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization-hTlIK1CP.js";
//#region src/agents/model-ref-shared.ts
function modelKey(provider, model) {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId) return modelId;
	if (!modelId) return providerId;
	return normalizeLowercaseStringOrEmpty(modelId).startsWith(`${normalizeLowercaseStringOrEmpty(providerId)}/`) ? modelId : `${providerId}/${modelId}`;
}
function normalizeStaticProviderModelId(provider, model, options = {}) {
	if (options.allowManifestNormalization === false) return model;
	return normalizeProviderModelIdWithManifest({
		provider,
		plugins: options.manifestPlugins,
		context: {
			provider,
			modelId: model
		}
	}) ?? model;
}
function parseStaticModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slash = trimmed.indexOf("/");
	const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
	const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
	if (!providerRaw || !modelRaw) return null;
	const provider = normalizeProviderId(providerRaw);
	return {
		provider,
		model: normalizeStaticProviderModelId(provider, modelRaw)
	};
}
function resolveStaticAllowlistModelKey(raw, defaultProvider) {
	const parsed = parseStaticModelRef(raw, defaultProvider);
	if (!parsed) return null;
	return modelKey(parsed.provider, parsed.model);
}
function formatLiteralProviderPrefixedModelRef(provider, modelRef) {
	const providerId = normalizeProviderId(provider);
	const trimmedRef = modelRef.trim();
	if (!providerId || !trimmedRef) return trimmedRef;
	const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
	const literalPrefix = `${providerId}/${providerId}/`;
	if (normalizedRef.startsWith(literalPrefix)) return trimmedRef;
	return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
//#endregion
export { resolveStaticAllowlistModelKey as i, modelKey as n, normalizeStaticProviderModelId as r, formatLiteralProviderPrefixedModelRef as t };
