import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as discoverOpenClawPlugins } from "./discovery-GEDtU7uI.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { n as PLUGIN_MANIFEST_FILENAME, r as getPackageManifestMetadata } from "./manifest-Cyo7Vmnr.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { a as resolveManifestContractPluginIds } from "./plugin-registry-CgH_ZSlH.js";
import { l as resolveLoaderPackageRoot } from "./sdk-alias-BqTLUqwL.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { i as resolveBundledPluginScanDir, r as normalizeBundledPluginStringList } from "./bundled-plugin-metadata-8-CcE95i.js";
import { t as loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime-DUjDEDJd.js";
import { i as resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit-BwvGaIk_.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/provider-contract-public-artifacts.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProviderPlugin(value) {
	return isRecord(value) && typeof value.id === "string" && typeof value.label === "string" && Array.isArray(value.auth);
}
function tryLoadProviderContractApi(pluginId) {
	try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: pluginId,
			artifactBasename: "provider-contract-api.js"
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) return null;
		throw error;
	}
}
function collectProviderContractEntries(params) {
	const providers = [];
	for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) => left.localeCompare(right))) {
		if (typeof exported !== "function" || exported.length !== 0 || !name.startsWith("create") || !name.endsWith("Provider")) continue;
		const candidate = exported();
		if (isProviderPlugin(candidate)) providers.push({
			pluginId: params.pluginId,
			provider: candidate
		});
	}
	return providers;
}
function resolveBundledExplicitProviderContractsFromPublicArtifacts(params) {
	const providers = [];
	for (const pluginId of [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right))) {
		const mod = tryLoadProviderContractApi(pluginId);
		if (!mod) return null;
		const entries = collectProviderContractEntries({
			pluginId,
			mod
		});
		if (entries.length === 0) return null;
		providers.push(...entries);
	}
	return providers;
}
//#endregion
//#region src/plugins/contracts/shared.ts
function uniqueStrings(values, normalize = (value) => value) {
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	for (const value of values ?? []) {
		const normalized = normalize(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
//#endregion
//#region src/plugins/contracts/inventory/bundled-capability-metadata.ts
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
	modulePath: CURRENT_MODULE_PATH,
	moduleUrl: import.meta.url
}) ?? fileURLToPath(new URL("../../../..", import.meta.url));
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
function readJsonRecord(filePath) {
	const raw = tryReadJsonSync(filePath);
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : void 0;
}
function readBundledCapabilityManifest(pluginDir) {
	if (normalizeBundledPluginStringList(getPackageManifestMetadata(readJsonRecord(path.join(pluginDir, "package.json")))?.extensions).length === 0) return;
	const raw = readJsonRecord(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
	if (!(typeof raw?.id === "string" ? raw.id.trim() : "")) return;
	return raw;
}
function listBundledCapabilityManifests() {
	const scanDir = resolveBundledPluginScanDir({
		packageRoot: OPENCLAW_PACKAGE_ROOT,
		runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT
	});
	if (!scanDir) return [];
	return fs.readdirSync(scanDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readBundledCapabilityManifest(path.join(scanDir, entry.name))).filter((manifest) => manifest !== void 0).toSorted((left, right) => left.id.localeCompare(right.id));
}
const BUNDLED_CAPABILITY_MANIFESTS = listBundledCapabilityManifests();
function normalizeStringListRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return {};
	return Object.fromEntries(Object.entries(record).map(([key, values]) => [key.trim(), uniqueStrings(Array.isArray(values) ? values : [], (value) => typeof value === "string" ? value.trim() : "")]).filter(([key, values]) => key && values.length > 0).toSorted(([left], [right]) => left.localeCompare(right)));
}
function buildBundledPluginContractSnapshot(manifest) {
	return {
		pluginId: manifest.id,
		cliBackendIds: uniqueStrings(manifest.cliBackends, (value) => value.trim()),
		providerIds: uniqueStrings(manifest.providers, (value) => value.trim()),
		providerAuthEnvVars: normalizeStringListRecord(manifest.providerAuthEnvVars),
		embeddingProviderIds: uniqueStrings(manifest.contracts?.embeddingProviders, (value) => value.trim()),
		speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders, (value) => value.trim()),
		realtimeTranscriptionProviderIds: uniqueStrings(manifest.contracts?.realtimeTranscriptionProviders, (value) => value.trim()),
		realtimeVoiceProviderIds: uniqueStrings(manifest.contracts?.realtimeVoiceProviders, (value) => value.trim()),
		mediaUnderstandingProviderIds: uniqueStrings(manifest.contracts?.mediaUnderstandingProviders, (value) => value.trim()),
		documentExtractorIds: uniqueStrings(manifest.contracts?.documentExtractors, (value) => value.trim()),
		imageGenerationProviderIds: uniqueStrings(manifest.contracts?.imageGenerationProviders, (value) => value.trim()),
		videoGenerationProviderIds: uniqueStrings(manifest.contracts?.videoGenerationProviders, (value) => value.trim()),
		musicGenerationProviderIds: uniqueStrings(manifest.contracts?.musicGenerationProviders, (value) => value.trim()),
		webContentExtractorIds: uniqueStrings(manifest.contracts?.webContentExtractors, (value) => value.trim()),
		webFetchProviderIds: uniqueStrings(manifest.contracts?.webFetchProviders, (value) => value.trim()),
		webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders, (value) => value.trim()),
		migrationProviderIds: uniqueStrings(manifest.contracts?.migrationProviders, (value) => value.trim()),
		toolNames: uniqueStrings(manifest.contracts?.tools, (value) => value.trim())
	};
}
function hasBundledPluginContractSnapshotCapabilities(entry) {
	return entry.cliBackendIds.length > 0 || entry.providerIds.length > 0 || entry.embeddingProviderIds.length > 0 || entry.speechProviderIds.length > 0 || entry.realtimeTranscriptionProviderIds.length > 0 || entry.realtimeVoiceProviderIds.length > 0 || entry.mediaUnderstandingProviderIds.length > 0 || entry.documentExtractorIds.length > 0 || entry.imageGenerationProviderIds.length > 0 || entry.videoGenerationProviderIds.length > 0 || entry.musicGenerationProviderIds.length > 0 || entry.webContentExtractorIds.length > 0 || entry.webFetchProviderIds.length > 0 || entry.webSearchProviderIds.length > 0 || entry.migrationProviderIds.length > 0 || entry.toolNames.length > 0;
}
const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS = BUNDLED_CAPABILITY_MANIFESTS.map(buildBundledPluginContractSnapshot).filter(hasBundledPluginContractSnapshotCapabilities).toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
Object.fromEntries(BUNDLED_CAPABILITY_MANIFESTS.flatMap((manifest) => (manifest.legacyPluginIds ?? []).map((legacyPluginId) => [legacyPluginId, manifest.id])).toSorted(([left], [right]) => left.localeCompare(right)));
Object.fromEntries(BUNDLED_CAPABILITY_MANIFESTS.flatMap((manifest) => (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [providerId, manifest.id])).toSorted(([left], [right]) => left.localeCompare(right)));
//#endregion
//#region src/plugins/contracts/speech-vitest-registry.ts
const VITEST_CONTRACT_PLUGIN_IDS = {
	imageGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.imageGenerationProviderIds.length > 0).map((entry) => entry.pluginId),
	speechProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.speechProviderIds.length > 0).map((entry) => entry.pluginId),
	mediaUnderstandingProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.mediaUnderstandingProviderIds.length > 0).map((entry) => entry.pluginId),
	realtimeVoiceProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.realtimeVoiceProviderIds.length > 0).map((entry) => entry.pluginId),
	realtimeTranscriptionProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.realtimeTranscriptionProviderIds.length > 0).map((entry) => entry.pluginId),
	videoGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.videoGenerationProviderIds.length > 0).map((entry) => entry.pluginId),
	musicGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.musicGenerationProviderIds.length > 0).map((entry) => entry.pluginId)
};
function loadVitestVideoGenerationFallbackEntries(pluginIds) {
	return loadVitestCapabilityContractEntries({
		contract: "videoGenerationProviders",
		pluginSdkResolution: "src",
		pluginIds,
		pickEntries: (registry) => registry.videoGenerationProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestMusicGenerationFallbackEntries(pluginIds) {
	return loadVitestCapabilityContractEntries({
		contract: "musicGenerationProviders",
		pluginSdkResolution: "src",
		pluginIds,
		pickEntries: (registry) => registry.musicGenerationProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestSpeechFallbackEntries(pluginIds) {
	return loadVitestCapabilityContractEntries({
		contract: "speechProviders",
		pluginSdkResolution: "src",
		pluginIds,
		pickEntries: (registry) => registry.speechProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function hasExplicitVideoGenerationModes(provider) {
	return Boolean(provider.capabilities.generate && provider.capabilities.imageToVideo && provider.capabilities.videoToVideo);
}
function hasExplicitMusicGenerationModes(provider) {
	return Boolean(provider.capabilities.generate && provider.capabilities.edit);
}
function loadVitestCapabilityContractEntries(params) {
	const pluginIds = [...params.pluginIds ?? VITEST_CONTRACT_PLUGIN_IDS[params.contract]];
	if (pluginIds.length === 0) return [];
	const bulkEntries = params.pickEntries(loadBundledCapabilityRuntimeRegistry({
		pluginIds,
		pluginSdkResolution: params.pluginSdkResolution ?? "dist"
	}));
	if (new Set(bulkEntries.map((entry) => entry.pluginId)).size === pluginIds.length) return bulkEntries;
	return pluginIds.flatMap((pluginId) => params.pickEntries(loadBundledCapabilityRuntimeRegistry({
		pluginIds: [pluginId],
		pluginSdkResolution: params.pluginSdkResolution ?? "dist"
	})).filter((entry) => entry.pluginId === pluginId));
}
function loadVitestSpeechProviderContractRegistry() {
	const entries = loadVitestCapabilityContractEntries({
		contract: "speechProviders",
		pickEntries: (registry) => registry.speechProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
	const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
	const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.speechProviders.filter((pluginId) => !coveredPluginIds.has(pluginId));
	if (missingPluginIds.length === 0) return entries;
	const replacementEntries = loadVitestSpeechFallbackEntries(missingPluginIds);
	const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
	return [...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)), ...replacementEntries];
}
function loadVitestMediaUnderstandingProviderContractRegistry() {
	return loadVitestCapabilityContractEntries({
		contract: "mediaUnderstandingProviders",
		pickEntries: (registry) => registry.mediaUnderstandingProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestRealtimeVoiceProviderContractRegistry() {
	return loadVitestCapabilityContractEntries({
		contract: "realtimeVoiceProviders",
		pickEntries: (registry) => registry.realtimeVoiceProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestRealtimeTranscriptionProviderContractRegistry() {
	return loadVitestCapabilityContractEntries({
		contract: "realtimeTranscriptionProviders",
		pickEntries: (registry) => registry.realtimeTranscriptionProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestImageGenerationProviderContractRegistry() {
	return loadVitestCapabilityContractEntries({
		contract: "imageGenerationProviders",
		pickEntries: (registry) => registry.imageGenerationProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
}
function loadVitestVideoGenerationProviderContractRegistry() {
	const entries = loadVitestCapabilityContractEntries({
		contract: "videoGenerationProviders",
		pickEntries: (registry) => registry.videoGenerationProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
	const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
	const stalePluginIds = new Set(entries.filter((entry) => !hasExplicitVideoGenerationModes(entry.provider)).map((entry) => entry.pluginId));
	const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.videoGenerationProviders.filter((pluginId) => !coveredPluginIds.has(pluginId) || stalePluginIds.has(pluginId));
	if (missingPluginIds.length === 0) return entries;
	const replacementEntries = loadVitestVideoGenerationFallbackEntries(missingPluginIds);
	const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
	return [...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)), ...replacementEntries];
}
function loadVitestMusicGenerationProviderContractRegistry() {
	const entries = loadVitestCapabilityContractEntries({
		contract: "musicGenerationProviders",
		pickEntries: (registry) => registry.musicGenerationProviders.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}))
	});
	const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
	const stalePluginIds = new Set(entries.filter((entry) => !hasExplicitMusicGenerationModes(entry.provider)).map((entry) => entry.pluginId));
	const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.musicGenerationProviders.filter((pluginId) => !coveredPluginIds.has(pluginId) || stalePluginIds.has(pluginId));
	if (missingPluginIds.length === 0) return entries;
	const replacementEntries = loadVitestMusicGenerationFallbackEntries(missingPluginIds);
	const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
	return [...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)), ...replacementEntries];
}
//#endregion
//#region src/plugins/contracts/registry.ts
function normalizeProviderAuthEnvVars(providerAuthEnvVars) {
	return Object.fromEntries(Object.entries(providerAuthEnvVars ?? {}).map(([providerId, envVars]) => [providerId, uniqueStrings(envVars)]));
}
function resolveBundledManifestContracts() {
	if (process.env.VITEST) return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => ({
		pluginId: entry.pluginId,
		cliBackendIds: [...entry.cliBackendIds],
		providerIds: [...entry.providerIds],
		providerAuthEnvVars: normalizeProviderAuthEnvVars(entry.providerAuthEnvVars),
		embeddingProviderIds: [...entry.embeddingProviderIds],
		speechProviderIds: [...entry.speechProviderIds],
		realtimeTranscriptionProviderIds: [...entry.realtimeTranscriptionProviderIds],
		realtimeVoiceProviderIds: [...entry.realtimeVoiceProviderIds],
		mediaUnderstandingProviderIds: [...entry.mediaUnderstandingProviderIds],
		documentExtractorIds: [...entry.documentExtractorIds],
		imageGenerationProviderIds: [...entry.imageGenerationProviderIds],
		videoGenerationProviderIds: [...entry.videoGenerationProviderIds],
		musicGenerationProviderIds: [...entry.musicGenerationProviderIds],
		webContentExtractorIds: [...entry.webContentExtractorIds],
		webFetchProviderIds: [...entry.webFetchProviderIds],
		webSearchProviderIds: [...entry.webSearchProviderIds],
		migrationProviderIds: [...entry.migrationProviderIds],
		toolNames: [...entry.toolNames]
	}));
	return loadPluginManifestRegistry({}).plugins.filter((plugin) => plugin.origin === "bundled" && (plugin.cliBackends.length > 0 || plugin.providers.length > 0 || (plugin.contracts?.embeddingProviders?.length ?? 0) > 0 || (plugin.contracts?.speechProviders?.length ?? 0) > 0 || (plugin.contracts?.realtimeTranscriptionProviders?.length ?? 0) > 0 || (plugin.contracts?.realtimeVoiceProviders?.length ?? 0) > 0 || (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0 || (plugin.contracts?.documentExtractors?.length ?? 0) > 0 || (plugin.contracts?.imageGenerationProviders?.length ?? 0) > 0 || (plugin.contracts?.videoGenerationProviders?.length ?? 0) > 0 || (plugin.contracts?.musicGenerationProviders?.length ?? 0) > 0 || (plugin.contracts?.webContentExtractors?.length ?? 0) > 0 || (plugin.contracts?.webFetchProviders?.length ?? 0) > 0 || (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 || (plugin.contracts?.migrationProviders?.length ?? 0) > 0 || (plugin.contracts?.tools?.length ?? 0) > 0)).map((plugin) => ({
		pluginId: plugin.id,
		cliBackendIds: uniqueStrings(plugin.cliBackends),
		providerIds: uniqueStrings(plugin.providers),
		providerAuthEnvVars: normalizeProviderAuthEnvVars(plugin.providerAuthEnvVars),
		embeddingProviderIds: uniqueStrings(plugin.contracts?.embeddingProviders ?? []),
		speechProviderIds: uniqueStrings(plugin.contracts?.speechProviders ?? []),
		realtimeTranscriptionProviderIds: uniqueStrings(plugin.contracts?.realtimeTranscriptionProviders ?? []),
		realtimeVoiceProviderIds: uniqueStrings(plugin.contracts?.realtimeVoiceProviders ?? []),
		mediaUnderstandingProviderIds: uniqueStrings(plugin.contracts?.mediaUnderstandingProviders ?? []),
		documentExtractorIds: uniqueStrings(plugin.contracts?.documentExtractors ?? []),
		imageGenerationProviderIds: uniqueStrings(plugin.contracts?.imageGenerationProviders ?? []),
		videoGenerationProviderIds: uniqueStrings(plugin.contracts?.videoGenerationProviders ?? []),
		musicGenerationProviderIds: uniqueStrings(plugin.contracts?.musicGenerationProviders ?? []),
		webContentExtractorIds: uniqueStrings(plugin.contracts?.webContentExtractors ?? []),
		webFetchProviderIds: uniqueStrings(plugin.contracts?.webFetchProviders ?? []),
		webSearchProviderIds: uniqueStrings(plugin.contracts?.webSearchProviders ?? []),
		migrationProviderIds: uniqueStrings(plugin.contracts?.migrationProviders ?? []),
		toolNames: uniqueStrings(plugin.contracts?.tools ?? [])
	}));
}
function resolveBundledProviderContractPluginIds() {
	return uniqueStrings(resolveBundledManifestContracts().filter((entry) => entry.providerIds.length > 0).map((entry) => entry.pluginId)).toSorted((left, right) => left.localeCompare(right));
}
function resolveBundledManifestContractPluginIds(contract) {
	return resolveManifestContractPluginIds({
		contract,
		origin: "bundled"
	});
}
function resolveBundledManifestPluginIdsForContract(contract) {
	return uniqueStrings(resolveBundledManifestContracts().filter((entry) => {
		switch (contract) {
			case "embeddingProviders": return entry.embeddingProviderIds.length > 0;
			case "speechProviders": return entry.speechProviderIds.length > 0;
			case "realtimeTranscriptionProviders": return entry.realtimeTranscriptionProviderIds.length > 0;
			case "realtimeVoiceProviders": return entry.realtimeVoiceProviderIds.length > 0;
			case "mediaUnderstandingProviders": return entry.mediaUnderstandingProviderIds.length > 0;
			case "documentExtractors": return entry.documentExtractorIds.length > 0;
			case "imageGenerationProviders": return entry.imageGenerationProviderIds.length > 0;
			case "videoGenerationProviders": return entry.videoGenerationProviderIds.length > 0;
			case "musicGenerationProviders": return entry.musicGenerationProviderIds.length > 0;
			case "webContentExtractors": return entry.webContentExtractorIds.length > 0;
			case "webFetchProviders": return entry.webFetchProviderIds.length > 0;
			case "webSearchProviders": return entry.webSearchProviderIds.length > 0;
			case "migrationProviders": return entry.migrationProviderIds.length > 0;
			case "tools": return entry.toolNames.length > 0;
		}
		throw new Error("Unsupported manifest contract key");
	}).map((entry) => entry.pluginId)).toSorted((left, right) => left.localeCompare(right));
}
let providerContractLoadError;
function formatBundledCapabilityPluginLoadError(params) {
	const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
	const diagnostics = params.registry.diagnostics.filter((entry) => entry.pluginId === params.pluginId).map((entry) => entry.message);
	const detailParts = plugin ? [
		`status=${plugin.status}`,
		...plugin.error ? [`error=${plugin.error}`] : [],
		`providerIds=[${plugin.providerIds.join(", ")}]`,
		`webFetchProviderIds=[${plugin.webFetchProviderIds.join(", ")}]`,
		`webSearchProviderIds=[${plugin.webSearchProviderIds.join(", ")}]`
	] : ["plugin record missing"];
	if (diagnostics.length > 0) detailParts.push(`diagnostics=${diagnostics.join(" | ")}`);
	return /* @__PURE__ */ new Error(`bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: ${detailParts.join("; ")}`);
}
function loadScopedCapabilityRuntimeRegistryEntries(params) {
	const discovery = discoverOpenClawPlugins({});
	let lastFailure;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const registry = loadBundledCapabilityRuntimeRegistry({
			pluginIds: [params.pluginId],
			pluginSdkResolution: "dist",
			discovery
		});
		const entries = params.loadEntries(registry);
		if (entries.length > 0) return entries;
		const plugin = registry.plugins.find((entry) => entry.id === params.pluginId);
		lastFailure = formatBundledCapabilityPluginLoadError({
			pluginId: params.pluginId,
			capabilityLabel: params.capabilityLabel,
			registry
		});
		if (!(attempt === 0 && (!plugin || plugin.status !== "loaded" || params.loadDeclaredIds(plugin).length === 0))) break;
	}
	throw lastFailure ?? /* @__PURE__ */ new Error(`bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: no entries`);
}
function loadProviderContractEntriesForPluginIds(pluginIds) {
	return pluginIds.flatMap((pluginId) => loadProviderContractEntriesForPluginId(pluginId));
}
function loadProviderContractEntriesForPluginId(pluginId) {
	const publicArtifactEntries = resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] });
	if (publicArtifactEntries) return publicArtifactEntries;
	try {
		providerContractLoadError = void 0;
		return loadScopedCapabilityRuntimeRegistryEntries({
			pluginId,
			capabilityLabel: "provider",
			loadEntries: (registry) => registry.providers.filter((entry) => entry.pluginId === pluginId).map((entry) => ({
				pluginId: entry.pluginId,
				provider: entry.provider
			})),
			loadDeclaredIds: (plugin) => plugin.providerIds
		}).map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		}));
	} catch (error) {
		providerContractLoadError = error instanceof Error ? error : new Error(String(error));
		return [];
	}
}
function loadProviderContractRegistry() {
	try {
		providerContractLoadError = void 0;
		const publicArtifactEntries = resolveBundledProviderContractPluginIds().flatMap((pluginId) => resolveBundledExplicitProviderContractsFromPublicArtifacts({ onlyPluginIds: [pluginId] }) ?? []);
		const coveredPluginIds = new Set(publicArtifactEntries.map((entry) => entry.pluginId));
		const remainingPluginIds = resolveBundledProviderContractPluginIds().filter((pluginId) => !coveredPluginIds.has(pluginId));
		const runtimeEntries = remainingPluginIds.length > 0 ? loadBundledCapabilityRuntimeRegistry({
			pluginIds: remainingPluginIds,
			pluginSdkResolution: "dist"
		}).providers.map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider
		})) : [];
		return [...publicArtifactEntries, ...runtimeEntries];
	} catch (error) {
		providerContractLoadError = error instanceof Error ? error : new Error(String(error));
		return [];
	}
}
function loadUniqueProviderContractProviders() {
	return [...new Map(loadProviderContractRegistry().map((entry) => [entry.provider.id, entry.provider])).values()];
}
function loadProviderContractPluginIds() {
	return [...resolveBundledProviderContractPluginIds()];
}
function loadProviderContractCompatPluginIds() {
	return loadProviderContractPluginIds();
}
function resolveWebSearchCredentialValue(provider) {
	if (provider.requiresCredential === false) return `${provider.id}-no-key-needed`;
	const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
	if (!envVar) return `${provider.id}-test`;
	if (envVar === "OPENROUTER_API_KEY") return "openrouter-test";
	return normalizeLowercaseStringOrEmpty(envVar).includes("api_key") ? `${provider.id}-test` : "sk-test";
}
function resolveWebFetchCredentialValue(provider) {
	if (provider.requiresCredential === false) return `${provider.id}-no-key-needed`;
	const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
	if (!envVar) return `${provider.id}-test`;
	return normalizeLowercaseStringOrEmpty(envVar).includes("api_key") ? `${provider.id}-test` : "sk-test";
}
function loadWebFetchProviderContractRegistry() {
	return loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestContractPluginIds("webFetchProviders"),
		pluginSdkResolution: "dist"
	}).webFetchProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider,
		credentialValue: resolveWebFetchCredentialValue(entry.provider)
	}));
}
function resolveWebFetchProviderContractEntriesForPluginId(pluginId) {
	return loadScopedCapabilityRuntimeRegistryEntries({
		pluginId,
		capabilityLabel: "web fetch provider",
		loadEntries: (registry) => registry.webFetchProviders.filter((entry) => entry.pluginId === pluginId).map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider,
			credentialValue: resolveWebFetchCredentialValue(entry.provider)
		})),
		loadDeclaredIds: (plugin) => plugin.webFetchProviderIds
	});
}
function loadWebSearchProviderContractRegistry() {
	const publicArtifactEntries = resolveBundledManifestContractPluginIds("webSearchProviders").flatMap((pluginId) => (resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds: [pluginId] }) ?? []).map((provider) => ({
		pluginId: provider.pluginId,
		provider,
		credentialValue: resolveWebSearchCredentialValue(provider)
	})));
	const coveredPluginIds = new Set(publicArtifactEntries.map((entry) => entry.pluginId));
	const remainingPluginIds = resolveBundledManifestContractPluginIds("webSearchProviders").filter((pluginId) => !coveredPluginIds.has(pluginId));
	const runtimeEntries = remainingPluginIds.length > 0 ? loadBundledCapabilityRuntimeRegistry({
		pluginIds: remainingPluginIds,
		pluginSdkResolution: "dist"
	}).webSearchProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider,
		credentialValue: resolveWebSearchCredentialValue(entry.provider)
	})) : [];
	return [...publicArtifactEntries, ...runtimeEntries];
}
function resolveWebSearchProviderContractEntriesForPluginId(pluginId) {
	const publicArtifactEntries = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds: [pluginId] })?.map((provider) => ({
		pluginId: provider.pluginId,
		provider,
		credentialValue: resolveWebSearchCredentialValue(provider)
	}));
	if (publicArtifactEntries) return publicArtifactEntries;
	return loadScopedCapabilityRuntimeRegistryEntries({
		pluginId,
		capabilityLabel: "web search provider",
		loadEntries: (registry) => registry.webSearchProviders.filter((entry) => entry.pluginId === pluginId).map((entry) => ({
			pluginId: entry.pluginId,
			provider: entry.provider,
			credentialValue: resolveWebSearchCredentialValue(entry.provider)
		})),
		loadDeclaredIds: (plugin) => plugin.webSearchProviderIds
	});
}
function loadSpeechProviderContractRegistry() {
	return process.env.VITEST ? loadVitestSpeechProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("speechProviders"),
		pluginSdkResolution: "dist"
	}).speechProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadRealtimeVoiceProviderContractRegistry() {
	return process.env.VITEST ? loadVitestRealtimeVoiceProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("realtimeVoiceProviders"),
		pluginSdkResolution: "dist"
	}).realtimeVoiceProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadRealtimeTranscriptionProviderContractRegistry() {
	return process.env.VITEST ? loadVitestRealtimeTranscriptionProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("realtimeTranscriptionProviders"),
		pluginSdkResolution: "dist"
	}).realtimeTranscriptionProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadMediaUnderstandingProviderContractRegistry() {
	return process.env.VITEST ? loadVitestMediaUnderstandingProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("mediaUnderstandingProviders"),
		pluginSdkResolution: "dist"
	}).mediaUnderstandingProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadImageGenerationProviderContractRegistry() {
	return process.env.VITEST ? loadVitestImageGenerationProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("imageGenerationProviders"),
		pluginSdkResolution: "dist"
	}).imageGenerationProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadVideoGenerationProviderContractRegistry() {
	return process.env.VITEST ? loadVitestVideoGenerationProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("videoGenerationProviders"),
		pluginSdkResolution: "dist"
	}).videoGenerationProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function loadMusicGenerationProviderContractRegistry() {
	return process.env.VITEST ? loadVitestMusicGenerationProviderContractRegistry() : loadBundledCapabilityRuntimeRegistry({
		pluginIds: resolveBundledManifestPluginIdsForContract("musicGenerationProviders"),
		pluginSdkResolution: "dist"
	}).musicGenerationProviders.map((entry) => ({
		pluginId: entry.pluginId,
		provider: entry.provider
	}));
}
function createLazyArrayView(load) {
	return new Proxy([], {
		get(_target, prop) {
			const actual = load();
			const value = Reflect.get(actual, prop, actual);
			return typeof value === "function" ? value.bind(actual) : value;
		},
		has(_target, prop) {
			return Reflect.has(load(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(load());
		},
		getOwnPropertyDescriptor(_target, prop) {
			const actual = load();
			const descriptor = Reflect.getOwnPropertyDescriptor(actual, prop);
			if (descriptor) return descriptor;
			if (Reflect.has(actual, prop)) return {
				configurable: true,
				enumerable: true,
				writable: false,
				value: Reflect.get(actual, prop, actual)
			};
		}
	});
}
createLazyArrayView(loadProviderContractRegistry);
createLazyArrayView(loadUniqueProviderContractProviders);
createLazyArrayView(loadProviderContractPluginIds);
createLazyArrayView(loadProviderContractCompatPluginIds);
function resolveProviderContractPluginIdsForProviderAlias(providerId) {
	const normalizedProvider = normalizeProviderId(providerId);
	if (!normalizedProvider) return;
	const pluginIds = uniqueStrings(loadProviderContractEntriesForPluginIds(resolveBundledProviderContractPluginIds()).filter((entry) => {
		return [
			entry.provider.id,
			...entry.provider.aliases ?? [],
			...entry.provider.hookAliases ?? []
		].some((candidate) => normalizeProviderId(candidate) === normalizedProvider);
	}).map((entry) => entry.pluginId)).toSorted((left, right) => left.localeCompare(right));
	return pluginIds.length > 0 ? pluginIds : void 0;
}
function resolveProviderContractProvidersForPluginIds(pluginIds) {
	const allowed = new Set(pluginIds);
	return [...new Map(loadProviderContractEntriesForPluginIds([...allowed]).filter((entry) => allowed.has(entry.pluginId)).map((entry) => [entry.provider.id, entry.provider])).values()];
}
createLazyArrayView(loadWebSearchProviderContractRegistry);
createLazyArrayView(loadWebFetchProviderContractRegistry);
createLazyArrayView(loadSpeechProviderContractRegistry);
createLazyArrayView(loadRealtimeTranscriptionProviderContractRegistry);
createLazyArrayView(loadRealtimeVoiceProviderContractRegistry);
createLazyArrayView(loadMediaUnderstandingProviderContractRegistry);
createLazyArrayView(loadImageGenerationProviderContractRegistry);
createLazyArrayView(loadVideoGenerationProviderContractRegistry);
createLazyArrayView(loadMusicGenerationProviderContractRegistry);
function loadPluginRegistrationContractRegistry() {
	return resolveBundledManifestContracts();
}
const pluginRegistrationContractRegistry = createLazyArrayView(loadPluginRegistrationContractRegistry);
//#endregion
export { resolveWebFetchProviderContractEntriesForPluginId as a, resolveProviderContractProvidersForPluginIds as i, providerContractLoadError as n, resolveWebSearchProviderContractEntriesForPluginId as o, resolveProviderContractPluginIdsForProviderAlias as r, resolveBundledExplicitProviderContractsFromPublicArtifacts as s, pluginRegistrationContractRegistry as t };
