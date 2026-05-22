import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { t as listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan-3We2Kt9Q.js";
//#region src/plugins/manifest-model-id-normalization.ts
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeTrimmedString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => normalizeTrimmedString(entry)).filter((entry) => entry !== void 0);
}
function normalizePrefixRules(value) {
	if (!Array.isArray(value)) return;
	const rules = [];
	for (const rawRule of value) {
		if (!isRecord(rawRule)) continue;
		const modelPrefix = normalizeTrimmedString(rawRule.modelPrefix);
		const prefix = normalizeTrimmedString(rawRule.prefix);
		if (modelPrefix && prefix) rules.push({
			modelPrefix,
			prefix
		});
	}
	return rules.length > 0 ? rules : void 0;
}
function normalizeModelIdNormalizationPolicy(value) {
	if (!isRecord(value)) return;
	const aliases = {};
	if (isRecord(value.aliases)) for (const [aliasRaw, canonicalRaw] of Object.entries(value.aliases)) {
		const alias = normalizeLowercaseStringOrEmpty(aliasRaw);
		const canonical = normalizeTrimmedString(canonicalRaw);
		if (alias && canonical) aliases[alias] = canonical;
	}
	const stripPrefixes = normalizeStringList(value.stripPrefixes);
	const prefixWhenBare = normalizeTrimmedString(value.prefixWhenBare);
	const prefixWhenBareAfterAliasStartsWith = normalizePrefixRules(value.prefixWhenBareAfterAliasStartsWith);
	const policy = {
		...Object.keys(aliases).length > 0 ? { aliases } : {},
		...stripPrefixes.length > 0 ? { stripPrefixes } : {},
		...prefixWhenBare ? { prefixWhenBare } : {},
		...prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}
	};
	return Object.keys(policy).length > 0 ? policy : void 0;
}
function readManifestModelIdNormalizationPolicies(manifest) {
	const modelIdNormalization = manifest.modelIdNormalization;
	if (!isRecord(modelIdNormalization) || !isRecord(modelIdNormalization.providers)) return [];
	const entries = [];
	for (const [providerRaw, rawPolicy] of Object.entries(modelIdNormalization.providers)) {
		const provider = normalizeLowercaseStringOrEmpty(providerRaw);
		const policy = normalizeModelIdNormalizationPolicy(rawPolicy);
		if (provider && policy) entries.push([provider, policy]);
	}
	return entries;
}
function collectManifestModelIdNormalizationPolicies() {
	const policies = /* @__PURE__ */ new Map();
	for (const { manifest } of listOpenClawPluginManifestMetadata()) for (const [provider, policy] of readManifestModelIdNormalizationPolicies(manifest)) policies.set(provider, policy);
	return policies;
}
function loadManifestModelIdNormalizationPolicies() {
	return collectManifestModelIdNormalizationPolicies();
}
function resolveManifestModelIdNormalizationPolicy(provider) {
	const providerId = normalizeLowercaseStringOrEmpty(provider);
	return loadManifestModelIdNormalizationPolicies().get(providerId);
}
function hasProviderPrefix(modelId) {
	return modelId.includes("/");
}
function formatPrefixedModelId(prefix, modelId) {
	return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}
function normalizeProviderModelIdWithManifest(params) {
	const policy = resolveManifestModelIdNormalizationPolicy(params.provider);
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
