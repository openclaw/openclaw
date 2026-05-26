import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { n as planManifestModelCatalogRows } from "./model-catalog-_Ht45y-A.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DHmOxzz2.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-Rt54Iaru.js";
import "./config-CzeRK-GW.js";
import { n as isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility-zsCdv7Ob.js";
import { t as augmentModelCatalogWithProviderPlugins } from "./provider-runtime.runtime.js";
import { r as buildConfiguredModelCatalog, w as modelSupportsInput } from "./model-selection-shared-Dh1KrVmr.js";
import { n as ensureOpenClawModelsJson } from "./models-config-0jkmTXsY.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
//#region src/agents/model-catalog.ts
const log = createSubsystemLogger("model-catalog");
const PI_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 128e3;
let modelCatalogPromise = null;
let hasLoggedModelCatalogError = false;
let hasLoggedReadOnlyStaticCatalogError = false;
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
	hasLoggedReadOnlyStaticCatalogError = false;
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
	const resolvedSnapshot = getCurrentPluginMetadataSnapshot({
		config: params.config,
		env: params.env,
		...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		...params.workspaceDir === void 0 ? { allowWorkspaceScopedSnapshot: true } : {}
	}) ?? (params.fallbackToMetadataScan === false ? void 0 : loadPluginMetadataSnapshot({
		config: params.config,
		...params.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		env: params.env ?? process.env
	}));
	if (!resolvedSnapshot) return [];
	return planManifestModelCatalogRows({ registry: { plugins: resolvedSnapshot.plugins.filter((plugin) => plugin.modelCatalog && isManifestPluginAvailableForControlPlane({
		snapshot: resolvedSnapshot,
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
		if (row.contextTokens) entry.contextTokens = row.contextTokens;
		if (typeof row.reasoning === "boolean") entry.reasoning = row.reasoning;
		if (row.input?.length) entry.input = [...row.input];
		if (row.compat) entry.compat = row.compat;
		return entry;
	});
}
function sortModelCatalogEntries(entries) {
	return entries.toSorted((a, b) => {
		const p = a.provider.localeCompare(b.provider);
		if (p !== 0) return p;
		return a.name.localeCompare(b.name);
	});
}
function normalizePersistedModelCatalogEntry(providerRaw, entry, defaults) {
	const rawId = normalizeOptionalString(entry.id) ?? "";
	if (!rawId) return;
	const provider = normalizeProviderId(providerRaw);
	if (!provider) return;
	const id = normalizeConfiguredProviderCatalogModelId(provider, rawId);
	const name = normalizeOptionalString(entry.name ?? id) || id;
	const contextWindow = typeof entry?.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : defaults?.contextWindow !== void 0 ? defaults.contextWindow : PI_CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW;
	const contextTokens = typeof entry?.contextTokens === "number" && entry.contextTokens > 0 ? entry.contextTokens : defaults?.contextTokens !== void 0 ? defaults.contextTokens : void 0;
	const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : false;
	const parsedInput = Array.isArray(entry?.input) ? entry.input.filter((value) => [
		"text",
		"image",
		"audio",
		"video",
		"document"
	].includes(String(value))) : void 0;
	const input = parsedInput?.length ? parsedInput : ["text"];
	const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : void 0;
	return {
		id,
		name,
		provider,
		contextWindow,
		...contextTokens !== void 0 ? { contextTokens } : {},
		reasoning,
		input,
		compat
	};
}
async function loadReadOnlyPersistedModelCatalog(params) {
	const cfg = params?.config ?? getRuntimeConfig();
	const raw = await readFile(join(resolveDefaultAgentDir(cfg), "models.json"), "utf8");
	const parsed = JSON.parse(raw);
	const models = [];
	const { buildShouldSuppressBuiltInModel } = await loadModelSuppression();
	const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModel({ config: cfg });
	const providers = parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {};
	for (const [providerRaw, providerConfig] of Object.entries(providers)) {
		if (!Array.isArray(providerConfig?.models)) continue;
		const providerContextWindow = typeof providerConfig?.contextWindow === "number" && providerConfig.contextWindow > 0 ? providerConfig.contextWindow : void 0;
		const providerContextTokens = typeof providerConfig?.contextTokens === "number" && providerConfig.contextTokens > 0 ? providerConfig.contextTokens : void 0;
		for (const entry of providerConfig.models) {
			const normalized = normalizePersistedModelCatalogEntry(providerRaw, entry, {
				contextWindow: providerContextWindow,
				contextTokens: providerContextTokens
			});
			if (normalized && !shouldSuppressBuiltInModel(normalized)) models.push(normalized);
		}
	}
	if (models.length === 0) throw new Error("persisted model catalog has no usable model rows");
	const configuredModels = buildConfiguredModelCatalog({ cfg });
	if (configuredModels.length > 0) appendCatalogEntriesIfAbsent(models, configuredModels);
	return sortModelCatalogEntries(models);
}
function loadReadOnlyStaticModelCatalog(params) {
	const cfg = params?.config ?? getRuntimeConfig();
	const models = [];
	try {
		appendCatalogEntriesIfAbsent(models, loadManifestModelCatalog({
			config: cfg,
			env: process.env,
			fallbackToMetadataScan: false
		}));
	} catch (error) {
		if (!hasLoggedReadOnlyStaticCatalogError) {
			hasLoggedReadOnlyStaticCatalogError = true;
			log.warn(`Failed to load read-only manifest model catalog: ${String(error)}`);
		}
	}
	const configuredModels = buildConfiguredModelCatalog({ cfg });
	if (configuredModels.length > 0) appendCatalogEntriesIfAbsent(models, configuredModels);
	return sortModelCatalogEntries(models);
}
async function loadModelCatalog(params) {
	const readOnly = params?.readOnly === true;
	if (readOnly) try {
		return await loadReadOnlyPersistedModelCatalog(params);
	} catch {
		return loadReadOnlyStaticModelCatalog(params);
	}
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
		const sortModels = sortModelCatalogEntries;
		try {
			const cfg = params?.config ?? getRuntimeConfig();
			if (!readOnly) {
				await ensureOpenClawModelsJson(cfg);
				logStage("models-json-ready");
			}
			const piSdk = await importPiSdk();
			logStage("pi-sdk-imported");
			const agentDir = resolveDefaultAgentDir(cfg);
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
				const rawId = normalizeOptionalString(entry?.id) ?? "";
				if (!rawId) continue;
				const provider = normalizeOptionalString(entry?.provider) ?? "";
				if (!provider) continue;
				const id = normalizeConfiguredProviderCatalogModelId(provider, rawId);
				if (shouldSuppressBuiltInModel({
					provider,
					id
				})) continue;
				const name = normalizeOptionalString(entry?.name ?? id) || id;
				const contextWindow = typeof entry?.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : void 0;
				const contextTokens = typeof entry?.contextTokens === "number" && entry.contextTokens > 0 ? entry.contextTokens : void 0;
				const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : void 0;
				const input = Array.isArray(entry?.input) ? entry.input : void 0;
				const compat = entry?.compat && typeof entry.compat === "object" ? entry.compat : void 0;
				models.push({
					id,
					name,
					provider,
					contextWindow,
					...contextTokens !== void 0 ? { contextTokens } : {},
					reasoning,
					input,
					compat
				});
			}
			if (!readOnly) {
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
				if (supplemental.length > 0) {
					const normalizedSupplemental = [];
					for (const entry of supplemental) normalizedSupplemental.push({
						...entry,
						id: normalizeConfiguredProviderCatalogModelId(entry.provider, entry.id)
					});
					appendCatalogEntriesIfAbsent(models, normalizedSupplemental);
				}
			}
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
