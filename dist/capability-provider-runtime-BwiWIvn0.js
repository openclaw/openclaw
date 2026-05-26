import { i as resolveConfigScopedRuntimeCacheValue } from "./plugin-cache-primitives-DcK62VYf.js";
import { n as withBundledPluginEnablementCompat, r as withBundledPluginVitestCompat, t as withBundledPluginAllowlistCompat } from "./bundled-compat-BkrhFp4r.js";
import { a as loadManifestContractSnapshot, n as isManifestPluginAvailableForControlPlane, t as hasManifestContractValue } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { d as resolveRuntimePluginRegistry, u as resolvePluginRegistryLoadCacheKey } from "./loader-DKK7Ita0.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { t as loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime-DUjDEDJd.js";
//#region src/plugins/capability-provider-runtime.ts
const capabilityProviderSnapshotCache = /* @__PURE__ */ new WeakMap();
const CAPABILITY_CONTRACT_KEY = {
	embeddingProviders: "embeddingProviders",
	memoryEmbeddingProviders: "memoryEmbeddingProviders",
	speechProviders: "speechProviders",
	realtimeTranscriptionProviders: "realtimeTranscriptionProviders",
	realtimeVoiceProviders: "realtimeVoiceProviders",
	mediaUnderstandingProviders: "mediaUnderstandingProviders",
	imageGenerationProviders: "imageGenerationProviders",
	videoGenerationProviders: "videoGenerationProviders",
	musicGenerationProviders: "musicGenerationProviders"
};
function shouldResolveWhenPluginsAreGloballyDisabled(key) {
	return key === "speechProviders";
}
function shouldMergeManifestProvidersWhenActive(key) {
	return key === "imageGenerationProviders" || key === "videoGenerationProviders" || key === "musicGenerationProviders";
}
function shouldSkipCapabilityResolution(params) {
	return params.cfg?.plugins?.enabled === false && !shouldResolveWhenPluginsAreGloballyDisabled(params.key);
}
function uniqueSorted(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function loadCapabilityManifestSnapshot(params) {
	return loadManifestContractSnapshot({
		config: params.cfg,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
}
function resolveCapabilityPluginIds(params) {
	const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
	const snapshot = loadCapabilityManifestSnapshot(params);
	const contractPlugins = snapshot.plugins.filter((plugin) => hasManifestContractValue({
		plugin,
		contract: contractKey,
		value: params.providerId
	}));
	return {
		runtimePluginIds: uniqueSorted(contractPlugins.filter((plugin) => isManifestPluginAvailableForControlPlane({
			snapshot,
			plugin,
			config: params.cfg
		})).map((plugin) => plugin.id)),
		bundledCompatPluginIds: uniqueSorted(contractPlugins.filter((plugin) => plugin.origin === "bundled").map((plugin) => plugin.id))
	};
}
function resolveBundledCapabilityCompatPluginIds(params) {
	return resolveCapabilityPluginIds(params).bundledCompatPluginIds;
}
function resolveCapabilityProviderConfig(params) {
	const pluginIds = params.pluginIds ?? resolveBundledCapabilityCompatPluginIds(params);
	return withBundledPluginVitestCompat({
		config: withBundledPluginEnablementCompat({
			config: withBundledPluginAllowlistCompat({
				config: params.cfg,
				pluginIds
			}),
			pluginIds
		}),
		pluginIds,
		env: process.env
	});
}
function createCapabilityProviderFallbackLoadOptions(params) {
	return {
		...params.compatConfig === void 0 ? {} : { config: params.compatConfig },
		onlyPluginIds: params.pluginIds,
		activate: false
	};
}
function resolveCapabilityProviderSnapshotCacheKey(params) {
	return JSON.stringify({
		key: params.key,
		load: resolvePluginRegistryLoadCacheKey(params.loadOptions)
	});
}
function findProviderById(entries, providerId) {
	const providerEntries = entries;
	for (const entry of providerEntries) if (entry.provider.id === providerId) return entry.provider;
}
function mergeCapabilityProviders(left, right) {
	const merged = /* @__PURE__ */ new Map();
	const unnamed = [];
	const addEntries = (entries) => {
		for (const entry of entries) {
			const provider = entry.provider;
			if (!provider.id) {
				unnamed.push(provider);
				continue;
			}
			if (!merged.has(provider.id)) merged.set(provider.id, provider);
		}
	};
	addEntries(left);
	addEntries(right);
	return [...merged.values(), ...unnamed];
}
function mergeCapabilityProviderEntries(left, right) {
	const merged = /* @__PURE__ */ new Map();
	const unnamed = [];
	const addEntries = (entries) => {
		for (const entry of entries) {
			const provider = entry.provider;
			if (!provider.id) {
				unnamed.push(entry);
				continue;
			}
			if (!merged.has(provider.id)) merged.set(provider.id, entry);
		}
	};
	addEntries(left);
	addEntries(right);
	return [...merged.values(), ...unnamed];
}
function addObjectKeys(target, value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	for (const key of Object.keys(value)) {
		const normalized = key.trim().toLowerCase();
		if (normalized) target.add(normalized);
	}
}
function addStringValue(target, value) {
	if (typeof value !== "string") return;
	const normalized = value.trim().toLowerCase();
	if (normalized) target.add(normalized);
}
function collectRequestedSpeechProviderIds(cfg) {
	const requested = /* @__PURE__ */ new Set();
	const tts = typeof cfg?.messages?.tts === "object" && cfg.messages.tts !== null ? cfg.messages.tts : void 0;
	addStringValue(requested, tts?.provider);
	addObjectKeys(requested, tts?.providers);
	addObjectKeys(requested, cfg?.models?.providers);
	return requested;
}
function addMediaModelProviders(target, value) {
	if (!Array.isArray(value)) return;
	for (const entry of value) if (typeof entry === "object" && entry !== null) addStringValue(target, entry.provider);
}
function collectRequestedMediaUnderstandingProviderIds(cfg) {
	const requested = /* @__PURE__ */ new Set();
	const media = cfg?.tools?.media;
	addMediaModelProviders(requested, media?.models);
	addMediaModelProviders(requested, media?.image?.models);
	addMediaModelProviders(requested, media?.audio?.models);
	addMediaModelProviders(requested, media?.video?.models);
	return requested;
}
function collectRequestedCapabilityProviderIds(params) {
	switch (params.key) {
		case "speechProviders": return collectRequestedSpeechProviderIds(params.cfg);
		case "mediaUnderstandingProviders": return collectRequestedMediaUnderstandingProviderIds(params.cfg);
		default: return;
	}
}
function removeActiveProviderIds(requested, entries) {
	for (const entry of entries) {
		const provider = entry.provider;
		if (typeof provider.id === "string") requested.delete(provider.id.toLowerCase());
		if (Array.isArray(provider.aliases)) {
			for (const alias of provider.aliases) if (typeof alias === "string") requested.delete(alias.toLowerCase());
		}
	}
}
function filterLoadedProvidersForRequestedConfig(params) {
	if (params.key !== "speechProviders" && params.key !== "realtimeTranscriptionProviders" && params.key !== "realtimeVoiceProviders" && params.key !== "mediaUnderstandingProviders") return [];
	if (params.requested.size === 0) return [];
	return params.entries.filter((entry) => {
		const provider = entry.provider;
		if (typeof provider.id === "string" && params.requested.has(provider.id.toLowerCase())) return true;
		if (Array.isArray(provider.aliases)) return provider.aliases.some((alias) => typeof alias === "string" && params.requested.has(alias.toLowerCase()));
		return false;
	});
}
function resolveRequestedCapabilityPluginIds(params) {
	if (!params.requested || params.requested.size === 0) return;
	const runtimePluginIds = /* @__PURE__ */ new Set();
	const bundledCompatPluginIds = /* @__PURE__ */ new Set();
	for (const providerId of params.requested) {
		const resolution = resolveCapabilityPluginIds({
			key: params.key,
			cfg: params.cfg,
			providerId
		});
		for (const pluginId of resolution.runtimePluginIds) runtimePluginIds.add(pluginId);
		for (const pluginId of resolution.bundledCompatPluginIds) bundledCompatPluginIds.add(pluginId);
	}
	return runtimePluginIds.size > 0 ? {
		runtimePluginIds: uniqueSorted(runtimePluginIds),
		bundledCompatPluginIds: uniqueSorted(bundledCompatPluginIds)
	} : void 0;
}
function loadCapabilityProviderEntries(params) {
	const loadedRegistry = getLoadedRuntimePluginRegistry({
		env: params.loadOptions.env,
		loadOptions: params.loadOptions,
		workspaceDir: params.loadOptions.workspaceDir,
		requiredPluginIds: params.loadOptions.onlyPluginIds
	});
	const loadedEntries = loadedRegistry?.[params.key] ?? [];
	const coldEntries = (loadedRegistry ? void 0 : resolveRuntimePluginRegistry(params.loadOptions))?.[params.key] ?? [];
	const entries = loadedEntries.length > 0 && coldEntries.length > 0 ? mergeCapabilityProviderEntries(loadedEntries, coldEntries) : loadedEntries.length > 0 ? loadedEntries : coldEntries;
	const missingRequested = params.requested && params.requested.size > 0 ? new Set(params.requested) : void 0;
	if (missingRequested) removeActiveProviderIds(missingRequested, entries);
	if (entries.length > 0 && (!missingRequested || missingRequested.size === 0)) return entries;
	if (params.bundledCompatPluginIds.length === 0) return entries;
	const captured = loadBundledCapabilityRuntimeRegistry({
		pluginIds: params.bundledCompatPluginIds,
		env: process.env,
		pluginSdkResolution: params.loadOptions.pluginSdkResolution
	})[params.key];
	return entries.length > 0 ? mergeCapabilityProviderEntries(entries, captured) : captured;
}
function resolvePluginCapabilityProvider(params) {
	if (shouldSkipCapabilityResolution(params)) return;
	const activeProvider = findProviderById(getLoadedRuntimePluginRegistry()?.[params.key] ?? [], params.providerId);
	if (activeProvider) return activeProvider;
	const pluginIds = resolveCapabilityPluginIds({
		key: params.key,
		cfg: params.cfg,
		providerId: params.providerId
	});
	if (pluginIds.runtimePluginIds.length === 0) return;
	const loadOptions = createCapabilityProviderFallbackLoadOptions({
		compatConfig: resolveCapabilityProviderConfig({
			key: params.key,
			cfg: params.cfg,
			pluginIds: pluginIds.bundledCompatPluginIds
		}),
		pluginIds: pluginIds.runtimePluginIds
	});
	return findProviderById(resolveConfigScopedRuntimeCacheValue({
		cache: capabilityProviderSnapshotCache,
		config: params.cfg,
		key: resolveCapabilityProviderSnapshotCacheKey({
			key: params.key,
			loadOptions
		}),
		load: () => loadCapabilityProviderEntries({
			key: params.key,
			bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
			loadOptions,
			requested: new Set([params.providerId.toLowerCase()])
		})
	}), params.providerId);
}
function resolveCachedCapabilityProviderEntries(params) {
	return resolveConfigScopedRuntimeCacheValue({
		cache: capabilityProviderSnapshotCache,
		config: params.cfg,
		key: resolveCapabilityProviderSnapshotCacheKey({
			key: params.key,
			loadOptions: params.loadOptions
		}),
		load: () => loadCapabilityProviderEntries({
			key: params.key,
			bundledCompatPluginIds: params.bundledCompatPluginIds,
			loadOptions: params.loadOptions,
			requested: params.requested
		})
	});
}
function resolvePluginCapabilityProviders(params) {
	if (shouldSkipCapabilityResolution(params)) return [];
	const activeProviders = getLoadedRuntimePluginRegistry()?.[params.key] ?? [];
	const missingRequestedProviders = activeProviders.length > 0 ? collectRequestedCapabilityProviderIds({
		key: params.key,
		cfg: params.cfg
	}) : void 0;
	if (activeProviders.length > 0 && params.key !== "memoryEmbeddingProviders") {
		if (!missingRequestedProviders && !shouldMergeManifestProvidersWhenActive(params.key)) return activeProviders.map((entry) => entry.provider);
		if (missingRequestedProviders) {
			removeActiveProviderIds(missingRequestedProviders, activeProviders);
			if (missingRequestedProviders.size === 0) return activeProviders.map((entry) => entry.provider);
		}
	}
	let requestedProviders;
	if (params.key === "speechProviders") requestedProviders = missingRequestedProviders ?? (activeProviders.length === 0 ? collectRequestedCapabilityProviderIds({
		key: params.key,
		cfg: params.cfg
	}) : void 0);
	const pluginIds = resolveRequestedCapabilityPluginIds({
		key: params.key,
		cfg: params.cfg,
		requested: requestedProviders
	}) ?? resolveCapabilityPluginIds({
		key: params.key,
		cfg: params.cfg
	});
	const loadOptions = createCapabilityProviderFallbackLoadOptions({
		compatConfig: resolveCapabilityProviderConfig({
			key: params.key,
			cfg: params.cfg,
			pluginIds: pluginIds.bundledCompatPluginIds
		}),
		pluginIds: pluginIds.runtimePluginIds
	});
	const loadedProviders = resolveCachedCapabilityProviderEntries({
		key: params.key,
		cfg: params.cfg,
		bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
		loadOptions,
		requested: requestedProviders
	});
	if (params.key !== "memoryEmbeddingProviders") return mergeCapabilityProviders(activeProviders, activeProviders.length > 0 && missingRequestedProviders ? filterLoadedProvidersForRequestedConfig({
		key: params.key,
		requested: missingRequestedProviders,
		entries: loadedProviders
	}) : loadedProviders);
	return mergeCapabilityProviders(activeProviders, loadedProviders);
}
//#endregion
export { resolvePluginCapabilityProvider as n, resolvePluginCapabilityProviders as r, loadCapabilityManifestSnapshot as t };
