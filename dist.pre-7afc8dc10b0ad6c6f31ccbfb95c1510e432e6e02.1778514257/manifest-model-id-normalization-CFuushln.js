import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-_DHvku_p.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DNKYLV32.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-Ct-1wZx-.js";
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
export { normalizeProviderModelIdWithManifest as t };
