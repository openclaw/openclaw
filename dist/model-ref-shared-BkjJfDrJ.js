import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as normalizeGooglePreviewModelId } from "./provider-model-id-normalize-BPUSCSQX.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-DRIYGASz.js";
//#region src/plugins/manifest-model-id-normalization.ts
function collectManifestModelIdNormalizationPolicies(plugins) {
	const policies = /* @__PURE__ */ new Map();
	for (const plugin of plugins) for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) policies.set(normalizeLowercaseStringOrEmpty(provider), policy);
	return policies;
}
let cachedPolicies;
function resolveMetadataSnapshotForPolicies(params = {}) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const current = getCurrentPluginMetadataSnapshot({
		config: params.config,
		env,
		workspaceDir
	});
	if (current) return {
		snapshot: current,
		cacheable: true
	};
	return {
		snapshot: loadPluginMetadataSnapshot({
			config: params.config ?? {},
			env,
			workspaceDir
		}),
		cacheable: false
	};
}
function loadManifestModelIdNormalizationPolicies(params = {}) {
	if (params.plugins) return collectManifestModelIdNormalizationPolicies(params.plugins);
	const { snapshot, cacheable } = resolveMetadataSnapshotForPolicies(params);
	const configFingerprint = snapshot.configFingerprint;
	if (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) return cachedPolicies.policies;
	const policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
	if (cacheable && configFingerprint) cachedPolicies = {
		configFingerprint,
		policies
	};
	return policies;
}
function resolveManifestModelIdNormalizationPolicy(provider, params = {}) {
	const providerId = normalizeLowercaseStringOrEmpty(provider);
	return loadManifestModelIdNormalizationPolicies(params).get(providerId);
}
function hasProviderPrefix(modelId) {
	return modelId.includes("/");
}
function formatPrefixedModelId(prefix, modelId) {
	return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}
function normalizeProviderModelIdWithManifest(params) {
	const policy = resolveManifestModelIdNormalizationPolicy(params.provider, params);
	if (!policy) return;
	let modelId = params.context.modelId.trim();
	if (!modelId) return modelId;
	for (const prefix of policy.stripPrefixes ?? []) {
		const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
		if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
			modelId = modelId.slice(prefix.length);
			break;
		}
	}
	modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;
	if (!hasProviderPrefix(modelId)) {
		for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) return formatPrefixedModelId(rule.prefix, modelId);
		if (policy.prefixWhenBare) return formatPrefixedModelId(policy.prefixWhenBare, modelId);
	}
	return modelId;
}
//#endregion
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
function normalizeConfiguredProviderCatalogModelId(provider, model, options = {}) {
	const providerModel = normalizeStaticProviderModelId(provider, model, options);
	const googlePrefix = "google/";
	if (!providerModel.startsWith(googlePrefix)) {
		const slash = providerModel.indexOf("/");
		if (slash <= 0 || slash >= providerModel.length - 1) return providerModel;
		const prefix = providerModel.slice(0, slash + 1);
		const suffix = providerModel.slice(slash + 1);
		if (!suffix.startsWith(googlePrefix)) return providerModel;
		const normalizedSuffix = normalizeGooglePreviewModelId(suffix);
		return normalizedSuffix === suffix ? providerModel : `${prefix}${normalizedSuffix}`;
	}
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
export { resolveStaticAllowlistModelKey as a, normalizeStaticProviderModelId as i, modelKey as n, normalizeProviderModelIdWithManifest as o, normalizeConfiguredProviderCatalogModelId as r, formatLiteralProviderPrefixedModelRef as t };
