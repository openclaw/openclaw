import { t as normalizeOptionalString } from "./string-D-gmGOgs.mjs";
//#region src/capability-model-ref.ts
function normalizeProviderForMatch(value, normalizeProviderId) {
	const normalized = normalizeOptionalString(value);
	return normalized && normalizeProviderId ? normalizeProviderId(normalized) : normalized;
}
function findCapabilityProviderById(params) {
	const selectedProvider = normalizeProviderForMatch(params.providerId, params.normalizeProviderId);
	if (!selectedProvider) return;
	return params.providers.find((provider) => {
		return normalizeProviderForMatch(provider.id, params.normalizeProviderId) === selectedProvider || (provider.aliases ?? []).some((alias) => normalizeProviderForMatch(alias, params.normalizeProviderId) === selectedProvider);
	});
}
function resolveCapabilityProviderModelOnlyRef(params) {
	const model = normalizeOptionalString(params.raw);
	if (!model) return null;
	const provider = params.providers.find((candidate) => {
		return [candidate.defaultModel, ...candidate.models ?? []].some((entry) => normalizeOptionalString(entry) === model);
	});
	return provider ? {
		provider: provider.id,
		model
	} : null;
}
function resolveCapabilityModelRefForProviders(params) {
	const raw = normalizeOptionalString(params.raw);
	if (!raw) return null;
	const parsed = params.parseModelRef(raw);
	if (parsed && findCapabilityProviderById({
		providers: params.providers,
		providerId: parsed.provider,
		normalizeProviderId: params.normalizeProviderId
	})) return parsed;
	return resolveCapabilityProviderModelOnlyRef({
		providers: params.providers,
		raw
	}) ?? parsed;
}
//#endregion
export { findCapabilityProviderById, resolveCapabilityModelRefForProviders, resolveCapabilityProviderModelOnlyRef };
