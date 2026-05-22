import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-C3dkeX_L.js";
import { n as normalizeGooglePreviewModelId } from "./provider-model-id-normalize-C2Wc1CzF.js";
import { t as normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization-BiKCD-8O.js";
//#region src/agents/model-ref-shared.ts
function modelKey(provider, model) {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId) return modelId;
	if (!modelId) return providerId;
	return normalizeLowercaseStringOrEmpty(modelId).startsWith(`${normalizeLowercaseStringOrEmpty(providerId)}/`) ? modelId : `${providerId}/${modelId}`;
}
function normalizeStaticProviderModelId(provider, model, options = {}) {
	const normalizedProvider = normalizeProviderId(provider);
	if (options.allowManifestNormalization === false) return normalizeBuiltInProviderModelId(normalizedProvider, model);
	return normalizeBuiltInProviderModelId(normalizedProvider, normalizeProviderModelIdWithManifest({
		provider: normalizedProvider,
		plugins: options.manifestPlugins,
		context: {
			provider: normalizedProvider,
			modelId: model
		}
	}) ?? model);
}
function normalizeBuiltInProviderModelId(provider, model) {
	if (provider === "google" || provider === "google-gemini-cli" || provider === "google-vertex") return normalizeGooglePreviewModelId(model);
	return model;
}
function normalizeConfiguredProviderCatalogModelId(provider, model) {
	const providerModel = normalizeStaticProviderModelId(provider, model);
	const googlePrefix = "google/";
	if (!providerModel.startsWith(googlePrefix)) return providerModel;
	const modelId = providerModel.slice(7);
	const normalizedModelId = normalizeGooglePreviewModelId(modelId);
	return normalizedModelId === modelId ? providerModel : `${googlePrefix}${normalizedModelId}`;
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
export { resolveStaticAllowlistModelKey as a, normalizeStaticProviderModelId as i, modelKey as n, normalizeConfiguredProviderCatalogModelId as r, formatLiteralProviderPrefixedModelRef as t };
