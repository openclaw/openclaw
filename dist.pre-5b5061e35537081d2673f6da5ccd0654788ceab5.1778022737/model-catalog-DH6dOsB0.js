import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-rXHPD8HR.js";
import { D as planManifestModelCatalogRows } from "./discovery-B19Xdk1_.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import "./config-CshcuIUd.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-C8E5kkmK.js";
import { n as isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility-DWkPvc9L.js";
import { t as resolveOpenClawAgentDir } from "./agent-paths-D7rhFYOo.js";
import { r as buildConfiguredModelCatalog, v as modelSupportsInput } from "./model-selection-shared-DbwzllLp.js";
import { t as augmentModelCatalogWithProviderPlugins } from "./provider-runtime.runtime.js";
import { n as ensureOpenClawModelsJson } from "./models-config-BJyE4NOp.js";
import { join } from "node:path";
//#region src/agents/model-catalog.ts
const log = createSubsystemLogger("model-catalog");
let modelCatalogPromise = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./agents/pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
const modelSuppressionLoader = createLazyImportLoader(() => import("./model-suppression.runtime.js"));
function shouldLogModelCatalogTiming() {
	return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}
function loadModelSuppression() {
	return modelSuppressionLoader.load();
}
function resetModelCatalogCache() {
	modelCatalogPromise = null;
	hasLoggedModelCatalogError = false;
}
function resetModelCatalogCacheForTest() {
	resetModelCatalogCache();
	importPiSdk = defaultImportPiSdk;
}
function __setModelCatalogImportForTest(loader) {
	importPiSdk = loader ?? defaultImportPiSdk;
}
function instantiatePiModelRegistry(piSdk, authStorage, modelsFile) {
	const Registry = piSdk.ModelRegistry;
	if (typeof Registry.create === "function") return Registry.create(authStorage, modelsFile);
	return new Registry(authStorage, modelsFile);
}
function catalogEntryDedupeKey(provider, id) {
	return `${normalizeProviderId(provider)}::${normalizeLowercaseStringOrEmpty(id)}`;
}
function appendCatalogEntriesIfAbsent(models, entries) {
	const seen = new Set(models.map((entry) => catalogEntryDedupeKey(entry.provider, entry.id)));
	for (const entry of entries) {
		const key = catalogEntryDedupeKey(entry.provider, entry.id);
		if (seen.has(key)) continue;
		models.push(entry);
		seen.add(key);
	}
}
function loadManifestModelCatalog(params) {
	const snapshot = getCurrentPluginMetadataSnapshot({
		config: params.config,
		...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {}
	}) ?? loadPluginMetadataSnapshot({
		config: params.config,
		...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		env: params.env ?? process.env
	});
	return planManifestModelCatalogRows({ registry: { plugins: snapshot.plugins.filter((plugin) => plugin.modelCatalog && isManifestPluginAvailableForControlPlane({
		snapshot,
		plugin,
		config: params.config
	})) } }).rows.map((row) => {
		const entry = {
			id: row.id,
			name: row.name,
			provider: row.provider
		};
		const contextWindow = row.contextWindow ?? row.contextTokens;
		if (contextWindow) entry.contextWindow = contextWindow;
		if (typeof row.reasoning === "boolean") entry.reasoning = row.reasoning;
		if (row.input?.length) entry.input = [...row.input];
		if (row.compat) entry.compat = row.compat;
		return entry;
	});
}
async function loadModelCatalog(params) {
	const readOnly = params?.readOnly === true;
	if (!readOnly && params?.useCache === false) modelCatalogPromise = null;
	if (!readOnly && modelCatalogPromise) return modelCatalogPromise;
	const loadCatalog = async () => {
		const models = [];
		const timingEnabled = shouldLogModelCatalogTiming();
		const startMs = timingEnabled ? Date.now() : 0;
		const logStage = (stage, extra) => {
			if (!timingEnabled) return;
			const suffix = extra ? ` ${extra}` : "";
			log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
		};
		const sortModels = (entries) => entries.sort((a, b) => {
			const p = a.provider.localeCompare(b.provider);
			if (p !== 0) return p;
			return a.name.localeCompare(b.name);
		});
		try {
			const cfg = params?.config ?? getRuntimeConfig();
			if (!readOnly) {
				await ensureOpenClawModelsJson(cfg);
				logStage("models-json-ready");
			}
			const piSdk = await importPiSdk();
			logStage("pi-sdk-imported");
			const agentDir = resolveOpenClawAgentDir();
			const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
			logStage("catalog-deps-ready");
			const authStorage = piSdk.discoverAuthStorage(agentDir, readOnly ? { readOnly: true } : void 0);
			logStage("auth-storage-ready");
			const registry = instantiatePiModelRegistry(piSdk, authStorage, join(agentDir, "models.json"));
			logStage("registry-ready");
			const entries = Array.isArray(registry) ? registry : registry.getAll();
			logStage("registry-read", `entries=${entries.length}`);
			const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModel({ config: cfg });
			logStage("suppress-resolver-ready");
			for (const entry of entries) {
				const id = normalizeOptionalString(entry?.id) ?? "";
				if (!id) continue;
				const provider = normalizeOptionalString(entry?.provider) ?? "";
				if (!provider) continue;
				if (shouldSuppressBuiltInModel({
					provider,
					id
				})) continue;
				const name = normalizeOptionalString(entry?.name ?? id) || id;
				const contextWindow = typeof entry?.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : void 0;
				const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : void 0;
				const input = Array.isArray(entry?.input) ? entry.input : void 0;
				const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : void 0;
				models.push({
					id,
					name,
					provider,
					contextWindow,
					reasoning,
					input,
					compat
				});
			}
			const supplemental = await augmentModelCatalogWithProviderPlugins({
				config: cfg,
				env: process.env,
				context: {
					config: cfg,
					agentDir,
					env: process.env,
					entries: [...models]
				}
			});
			if (supplemental.length > 0) appendCatalogEntriesIfAbsent(models, supplemental);
			logStage("plugin-models-merged", `entries=${models.length}`);
			const configuredModels = buildConfiguredModelCatalog({ cfg });
			if (configuredModels.length > 0) appendCatalogEntriesIfAbsent(models, configuredModels);
			logStage("configured-models-merged", `entries=${models.length}`);
			if (models.length === 0) {
				if (!readOnly) modelCatalogPromise = null;
			}
			const sorted = sortModels(models);
			logStage("complete", `entries=${sorted.length}`);
			return sorted;
		} catch (error) {
			if (!hasLoggedModelCatalogError) {
				hasLoggedModelCatalogError = true;
				log.warn(`Failed to load model catalog: ${String(error)}`);
			}
			if (!readOnly) modelCatalogPromise = null;
			if (models.length > 0) return sortModels(models);
			return [];
		}
	};
	if (readOnly) return loadCatalog();
	modelCatalogPromise = loadCatalog();
	return modelCatalogPromise;
}
/**
* Check if a model supports image input based on its catalog entry.
*/
function modelSupportsVision(entry) {
	return modelSupportsInput(entry, "image");
}
/**
* Check if a model supports native document/PDF input based on its catalog entry.
*/
function modelSupportsDocument(entry) {
	return modelSupportsInput(entry, "document");
}
//#endregion
export { modelSupportsVision as a, modelSupportsDocument as i, loadManifestModelCatalog as n, resetModelCatalogCache as o, loadModelCatalog as r, resetModelCatalogCacheForTest as s, __setModelCatalogImportForTest as t };
