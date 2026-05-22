import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-DAC6GNWm.js";
//#region src/plugins/web-provider-public-artifacts.explicit.ts
const WEB_SEARCH_ARTIFACT_CANDIDATES = [
	"web-search-contract-api.js",
	"web-search-provider.js",
	"web-search.js"
];
const WEB_FETCH_ARTIFACT_CANDIDATES = [
	"web-fetch-contract-api.js",
	"web-fetch-provider.js",
	"web-fetch.js"
];
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isWebProviderPlugin(value) {
	return isRecord(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.hint === "string" && isStringArray(value.envVars) && typeof value.placeholder === "string" && typeof value.signupUrl === "string" && typeof value.credentialPath === "string" && typeof value.getCredentialValue === "function" && typeof value.setCredentialValue === "function" && typeof value.createTool === "function";
}
function isWebSearchProviderPlugin(value) {
	return isWebProviderPlugin(value);
}
function isWebFetchProviderPlugin(value) {
	return isWebProviderPlugin(value);
}
function collectProviderFactories(params) {
	const providers = [];
	for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (typeof exported !== "function" || exported.length !== 0 || !name.startsWith("create") || !name.endsWith(params.suffix)) continue;
		const candidate = exported();
		if (params.isProvider(candidate)) providers.push(candidate);
	}
	return providers;
}
function tryLoadBundledPublicArtifactModule(params) {
	for (const artifactBasename of params.artifactCandidates) try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: params.dirName,
			artifactBasename
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
		throw error;
	}
	return null;
}
function normalizeExplicitBundledPluginIds(pluginIds) {
	return [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right));
}
function loadBundledProviderEntriesFromDir(params) {
	const mod = tryLoadBundledPublicArtifactModule({
		dirName: params.dirName,
		artifactCandidates: params.artifactCandidates
	});
	if (!mod) return null;
	const providers = collectProviderFactories({
		mod,
		suffix: params.suffix,
		isProvider: params.isProvider
	});
	if (providers.length === 0) return null;
	return providers.map((provider) => Object.assign({}, provider, { pluginId: params.pluginId }));
}
function loadBundledWebSearchProviderEntriesFromDir(params) {
	return loadBundledProviderEntriesFromDir({
		dirName: params.dirName,
		pluginId: params.pluginId,
		artifactCandidates: WEB_SEARCH_ARTIFACT_CANDIDATES,
		suffix: "WebSearchProvider",
		isProvider: isWebSearchProviderPlugin
	});
}
function loadBundledWebFetchProviderEntriesFromDir(params) {
	return loadBundledProviderEntriesFromDir({
		dirName: params.dirName,
		pluginId: params.pluginId,
		artifactCandidates: WEB_FETCH_ARTIFACT_CANDIDATES,
		suffix: "WebFetchProvider",
		isProvider: isWebFetchProviderPlugin
	});
}
function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params) {
	const providers = [];
	for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
		const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
			dirName: pluginId,
			pluginId
		});
		if (!loadedProviders) return null;
		providers.push(...loadedProviders);
	}
	return providers;
}
function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params) {
	const providers = [];
	for (const pluginId of normalizeExplicitBundledPluginIds(params.onlyPluginIds)) {
		const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
			dirName: pluginId,
			pluginId
		});
		if (!loadedProviders) return null;
		providers.push(...loadedProviders);
	}
	return providers;
}
//#endregion
export { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts as i, loadBundledWebSearchProviderEntriesFromDir as n, resolveBundledExplicitWebFetchProvidersFromPublicArtifacts as r, loadBundledWebFetchProviderEntriesFromDir as t };
