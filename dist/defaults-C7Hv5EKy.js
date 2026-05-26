import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { h as resolveRuntimeConfigCacheKey } from "./runtime-snapshot-tLK3Mx7y.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-zsCdv7Ob.js";
import { n as normalizeMediaProviderId } from "./config-provider-models-DxFLCJCh.js";
import "./defaults.constants-CRZ3dal0.js";
import { t as providerSupportsCapability } from "./provider-supports-I3oxw6PP.js";
//#region src/media-understanding/manifest-metadata.ts
function buildMediaUnderstandingManifestMetadataRegistry(cfg, workspaceDir) {
	const registry = /* @__PURE__ */ new Map();
	const snapshot = loadManifestMetadataSnapshot({
		config: cfg,
		env: process.env,
		...workspaceDir ? { workspaceDir } : {}
	});
	for (const plugin of snapshot.plugins) {
		const declaredProviders = new Set((plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) => normalizeMediaProviderId(providerId)));
		for (const [providerId, metadata] of Object.entries(plugin.mediaUnderstandingProviderMetadata ?? {})) {
			const normalizedProviderId = normalizeMediaProviderId(providerId);
			if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) continue;
			registry.set(normalizedProviderId, {
				id: normalizedProviderId,
				capabilities: metadata.capabilities,
				defaultModels: metadata.defaultModels,
				autoPriority: metadata.autoPriority,
				nativeDocumentInputs: metadata.nativeDocumentInputs
			});
		}
	}
	return registry;
}
//#endregion
//#region src/media-understanding/defaults.ts
let defaultRegistryCache = null;
const configRegistryCache = /* @__PURE__ */ new Map();
const MAX_CONFIG_REGISTRY_CACHE_ENTRIES = 32;
function cacheConfigRegistry(key, registry) {
	if (!configRegistryCache.has(key) && configRegistryCache.size >= MAX_CONFIG_REGISTRY_CACHE_ENTRIES) {
		const oldestKey = configRegistryCache.keys().next().value;
		if (oldestKey) configRegistryCache.delete(oldestKey);
	}
	configRegistryCache.set(key, registry);
	return registry;
}
function resolveDefaultRegistry(cfg, workspaceDir) {
	if (!cfg) {
		defaultRegistryCache ??= buildMediaUnderstandingManifestMetadataRegistry();
		return defaultRegistryCache;
	}
	const cacheKey = `${resolveRuntimeConfigCacheKey(cfg)}:${workspaceDir ?? ""}`;
	const cached = configRegistryCache.get(cacheKey);
	if (cached) return cached;
	return cacheConfigRegistry(cacheKey, buildMediaUnderstandingManifestMetadataRegistry(cfg, workspaceDir));
}
function providerHasDeclaredCapability(provider, capability) {
	return provider?.capabilities?.includes(capability) ?? providerSupportsCapability(provider, capability);
}
function resolveConfiguredImageProviderModel(params) {
	const providers = params.cfg?.models?.providers;
	if (!providers || typeof providers !== "object") return;
	const normalizedProviderId = normalizeMediaProviderId(params.providerId);
	for (const [providerKey, providerCfg] of Object.entries(providers)) {
		if (normalizeMediaProviderId(providerKey) !== normalizedProviderId) continue;
		return normalizeOptionalString((providerCfg?.models ?? []).find((model) => Boolean(normalizeOptionalString(model?.id)) && Array.isArray(model?.input) && model.input.includes("image"))?.id);
	}
}
function resolveConfiguredImageProviderIds(cfg) {
	const providers = cfg?.models?.providers;
	if (!providers || typeof providers !== "object") return [];
	const configured = [];
	for (const [providerKey, providerCfg] of Object.entries(providers)) {
		const normalizedProviderId = normalizeMediaProviderId(providerKey);
		if (!normalizedProviderId || configured.includes(normalizedProviderId)) continue;
		if ((providerCfg?.models ?? []).some((model) => Array.isArray(model?.input) && model.input.includes("image"))) configured.push(normalizedProviderId);
	}
	return configured;
}
function resolveDefaultMediaModel(params) {
	if (!params.providerRegistry) {
		const configuredImageModel = params.capability === "image" ? resolveConfiguredImageProviderModel({
			cfg: params.cfg,
			providerId: params.providerId
		}) : void 0;
		if (configuredImageModel) return configuredImageModel;
	}
	return normalizeOptionalString((params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir)).get(normalizeMediaProviderId(params.providerId))?.defaultModels?.[params.capability]);
}
function resolveAutoMediaKeyProviders(params) {
	const prioritized = [...(params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir)).values()].filter((provider) => providerHasDeclaredCapability(provider, params.capability)).map((provider) => {
		const priority = provider.autoPriority?.[params.capability];
		return typeof priority === "number" && Number.isFinite(priority) ? {
			provider,
			priority
		} : null;
	}).filter((entry) => entry !== null).toSorted((left, right) => {
		if (left.priority !== right.priority) return left.priority - right.priority;
		return left.provider.id.localeCompare(right.provider.id);
	}).map((entry) => normalizeMediaProviderId(entry.provider.id)).filter(Boolean);
	if (params.providerRegistry || params.capability !== "image") return prioritized;
	return [...new Set([...prioritized, ...resolveConfiguredImageProviderIds(params.cfg)])];
}
function providerSupportsNativePdfDocument(params) {
	return (params.providerRegistry ?? resolveDefaultRegistry(params.cfg, params.workspaceDir)).get(normalizeMediaProviderId(params.providerId))?.nativeDocumentInputs?.includes("pdf") ?? false;
}
//#endregion
export { resolveAutoMediaKeyProviders as n, resolveDefaultMediaModel as r, providerSupportsNativePdfDocument as t };
