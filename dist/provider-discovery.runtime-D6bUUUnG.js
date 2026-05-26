import { r as getCachedPluginSourceModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { u as resolveDiscoveredProviderPluginIds } from "./plugin-auto-enable-CuCUT4Z1.js";
import { i as withProfile } from "./plugin-load-profile-DOnG9jJ5.js";
import { n as resolvePluginProviders } from "./providers.runtime-CsXUlav0.js";
//#region src/plugins/source-loader.ts
function createPluginSourceLoader() {
	const loaders = createPluginModuleLoaderCache();
	return (modulePath) => {
		const sourceLoader = getCachedPluginSourceModuleLoader({
			cache: loaders,
			modulePath,
			importerUrl: import.meta.url,
			loaderFilename: import.meta.url
		});
		return withProfile({
			pluginId: "(direct)",
			source: modulePath
		}, "source-loader", () => sourceLoader(modulePath));
	};
}
//#endregion
//#region src/plugins/provider-discovery.runtime.ts
function normalizeDiscoveryModule(value) {
	const resolved = value && typeof value === "object" && "default" in value && value.default !== void 0 ? value.default : value;
	if (Array.isArray(resolved)) return resolved;
	if (resolved && typeof resolved === "object" && "id" in resolved) return [resolved];
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value;
		if (Array.isArray(record.providers)) return record.providers;
		if (record.provider) return [record.provider];
	}
	return [];
}
function hasLiveProviderDiscoveryHook(provider) {
	return typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function";
}
function hasProviderAuthEnvCredential(plugin, env) {
	return [...(plugin.setup?.providers ?? []).flatMap((provider) => provider.envVars ?? []), ...Object.values(plugin.providerAuthEnvVars ?? {}).flat()].some((name) => {
		const value = env[name]?.trim();
		return value !== void 0 && value !== "";
	});
}
function dedupeSorted(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function resolveProviderDiscoveryEntryPlugins(params) {
	const metadataSnapshot = params.pluginMetadataSnapshot ?? loadManifestMetadataSnapshot({
		config: params.config ?? {},
		env: params.env ?? process.env,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	const registry = metadataSnapshot.index;
	const manifestRegistry = metadataSnapshot.manifestRegistry;
	const pluginIds = resolveDiscoveredProviderPluginIds({
		...params,
		registry,
		manifestRegistry
	});
	const pluginIdSet = new Set(pluginIds);
	const pluginRecords = manifestRegistry.plugins.filter((plugin) => pluginIdSet.has(plugin.id));
	const entryRecords = pluginRecords.filter((plugin) => plugin.providerDiscoverySource);
	const entryPluginIds = new Set(entryRecords.map((plugin) => plugin.id));
	if (entryRecords.length === 0) return {
		providers: [],
		complete: false,
		pluginRecords,
		entryPluginIds
	};
	const complete = entryRecords.length === pluginIdSet.size;
	if (params.requireCompleteDiscoveryEntryCoverage && !complete) return {
		providers: [],
		complete: false,
		pluginRecords,
		entryPluginIds
	};
	const loadSource = createPluginSourceLoader();
	const providers = [];
	for (const manifest of entryRecords) try {
		const moduleExport = loadSource(manifest.providerDiscoverySource);
		providers.push(...normalizeDiscoveryModule(moduleExport).map((provider) => Object.assign({}, provider, { pluginId: manifest.id })));
	} catch {
		return {
			providers: [],
			complete: false,
			pluginRecords,
			entryPluginIds
		};
	}
	return {
		providers,
		complete,
		pluginRecords,
		entryPluginIds
	};
}
function resolveSelectiveFullPluginIds(params) {
	const staticOnlyEntryPluginIds = params.entryProviders.filter((provider) => !hasLiveProviderDiscoveryHook(provider)).map((provider) => provider.pluginId).filter((pluginId) => typeof pluginId === "string" && pluginId !== "");
	const missingEntryCredentialPluginIds = params.entryResult.pluginRecords.filter((plugin) => !params.entryResult.entryPluginIds.has(plugin.id)).filter((plugin) => hasProviderAuthEnvCredential(plugin, params.env)).map((plugin) => plugin.id);
	return dedupeSorted([...staticOnlyEntryPluginIds, ...missingEntryCredentialPluginIds]);
}
function resolvePluginDiscoveryProvidersRuntime(params) {
	const env = params.env ?? process.env;
	const entryResult = resolveProviderDiscoveryEntryPlugins({
		...params,
		env
	});
	if (params.discoveryEntriesOnly === true) return entryResult.providers;
	const liveEntryProviders = entryResult.providers.filter(hasLiveProviderDiscoveryHook);
	if (entryResult.complete && liveEntryProviders.length === entryResult.providers.length) return liveEntryProviders;
	if (params.onlyPluginIds === void 0 && entryResult.providers.length > 0) {
		const fullPluginIds = resolveSelectiveFullPluginIds({
			entryResult,
			entryProviders: entryResult.providers,
			env
		});
		const fullProviders = fullPluginIds.length > 0 ? resolvePluginProviders({
			...params,
			env,
			onlyPluginIds: fullPluginIds,
			bundledProviderAllowlistCompat: true
		}) : [];
		return [...liveEntryProviders, ...fullProviders];
	}
	return resolvePluginProviders({
		...params,
		env,
		bundledProviderAllowlistCompat: true
	});
}
//#endregion
export { resolvePluginDiscoveryProvidersRuntime as t };
