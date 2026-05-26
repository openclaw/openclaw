import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
import { r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { t as buildAuthProfileId } from "./identity-B9_6eGVi.js";
//#region src/plugin-sdk/provider-auth-result.ts
function normalizeAgentModelConfigForAuthResult(value) {
	if (typeof value === "string") return normalizeAgentModelRefForConfig(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	let mutated = false;
	const next = { ...value };
	if (typeof next.primary === "string") {
		const primary = normalizeAgentModelRefForConfig(next.primary);
		if (primary !== next.primary) {
			next.primary = primary;
			mutated = true;
		}
	}
	if (Array.isArray(next.fallbacks)) {
		const originalFallbacks = next.fallbacks;
		const fallbacks = originalFallbacks.map((fallback) => typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback);
		if (fallbacks.some((fallback, index) => fallback !== originalFallbacks[index])) {
			next.fallbacks = fallbacks;
			mutated = true;
		}
	}
	return mutated ? next : value;
}
function normalizeProviderConfigModelIdsForAuthResult(provider, providerConfig) {
	const models = providerConfig.models;
	if (!Array.isArray(models) || models.length === 0) return providerConfig;
	let mutated = false;
	const nextModels = models.map((model) => {
		const id = normalizeConfiguredProviderCatalogModelId(provider, model.id);
		if (id === model.id) return model;
		mutated = true;
		return Object.assign({}, model, { id });
	});
	return mutated ? {
		...providerConfig,
		models: nextModels
	} : providerConfig;
}
function normalizeProviderAuthConfigPatchModelRefs(patch) {
	let next = patch;
	const defaults = patch.agents?.defaults;
	if (defaults) {
		let nextDefaults = defaults;
		if (defaults.model !== void 0) {
			const model = normalizeAgentModelConfigForAuthResult(defaults.model);
			if (model !== defaults.model) nextDefaults = {
				...nextDefaults,
				model
			};
		}
		if (defaults.models) {
			const models = normalizeAgentModelMapForConfig(defaults.models);
			if (models !== defaults.models) nextDefaults = {
				...nextDefaults,
				models
			};
		}
		if (nextDefaults !== defaults) next = {
			...next,
			agents: {
				...next.agents,
				defaults: nextDefaults
			}
		};
	}
	const providers = patch.models?.providers;
	if (!providers) return next;
	let mutated = false;
	const nextProviders = { ...providers };
	for (const [provider, providerConfig] of Object.entries(providers)) {
		const normalized = normalizeProviderConfigModelIdsForAuthResult(provider, providerConfig);
		if (normalized === providerConfig) continue;
		nextProviders[provider] = normalized;
		mutated = true;
	}
	return mutated ? {
		...next,
		models: {
			...next.models,
			providers: nextProviders
		}
	} : next;
}
/** Build the standard auth result payload for OAuth-style provider login flows. */
function buildOauthProviderAuthResult(params) {
	const email = params.email ?? void 0;
	const displayName = params.displayName ?? void 0;
	const defaultModel = normalizeAgentModelRefForConfig(params.defaultModel);
	return {
		profiles: [{
			profileId: buildAuthProfileId({
				providerId: params.providerId,
				profilePrefix: params.profilePrefix,
				profileName: params.profileName ?? email
			}),
			credential: {
				type: "oauth",
				provider: params.providerId,
				access: params.access,
				...params.refresh ? { refresh: params.refresh } : {},
				...Number.isFinite(params.expires) ? { expires: params.expires } : {},
				...email ? { email } : {},
				...displayName ? { displayName } : {},
				...params.credentialExtra
			}
		}],
		configPatch: normalizeProviderAuthConfigPatchModelRefs(params.configPatch ?? { agents: { defaults: { models: { [defaultModel]: {} } } } }),
		defaultModel,
		notes: params.notes
	};
}
//#endregion
export { buildOauthProviderAuthResult as t };
