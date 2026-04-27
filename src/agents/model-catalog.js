import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { normalizeProviderId } from "./provider-id.js";
const log = createSubsystemLogger("model-catalog");
let modelCatalogPromise = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
let modelSuppressionPromise;
function shouldLogModelCatalogTiming() {
    return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}
function loadModelSuppression() {
    modelSuppressionPromise ??= import("./model-suppression.runtime.js");
    return modelSuppressionPromise;
}
export function resetModelCatalogCache() {
    modelCatalogPromise = null;
    hasLoggedModelCatalogError = false;
    importPiSdk = defaultImportPiSdk;
}
export function resetModelCatalogCacheForTest() {
    resetModelCatalogCache();
}
// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader) {
    importPiSdk = loader ?? defaultImportPiSdk;
}
function instantiatePiModelRegistry(piSdk, authStorage, modelsFile) {
    const Registry = piSdk.ModelRegistry;
    if (typeof Registry.create === "function") {
        return Registry.create(authStorage, modelsFile);
    }
    return new Registry(authStorage, modelsFile);
}
export async function loadModelCatalog(params) {
    const readOnly = params?.readOnly === true;
    if (!readOnly && params?.useCache === false) {
        modelCatalogPromise = null;
    }
    if (!readOnly && modelCatalogPromise) {
        return modelCatalogPromise;
    }
    const loadCatalog = async () => {
        const models = [];
        const timingEnabled = shouldLogModelCatalogTiming();
        const startMs = timingEnabled ? Date.now() : 0;
        const logStage = (stage, extra) => {
            if (!timingEnabled) {
                return;
            }
            const suffix = extra ? ` ${extra}` : "";
            log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
        };
        const sortModels = (entries) => entries.sort((a, b) => {
            const p = a.provider.localeCompare(b.provider);
            if (p !== 0) {
                return p;
            }
            return a.name.localeCompare(b.name);
        });
        try {
            const cfg = params?.config ?? loadConfig();
            if (!readOnly) {
                await ensureOpenClawModelsJson(cfg);
                logStage("models-json-ready");
            }
            // IMPORTANT: keep the dynamic import *inside* the try/catch.
            // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
            // we must not poison the cache with a rejected promise (otherwise all channel handlers
            // will keep failing until restart).
            const piSdk = await importPiSdk();
            logStage("pi-sdk-imported");
            const agentDir = resolveOpenClawAgentDir();
            const { shouldSuppressBuiltInModel } = await loadModelSuppression();
            logStage("catalog-deps-ready");
            const authStorage = piSdk.discoverAuthStorage(agentDir, readOnly ? { readOnly: true } : undefined);
            logStage("auth-storage-ready");
            const registry = instantiatePiModelRegistry(piSdk, authStorage, join(agentDir, "models.json"));
            logStage("registry-ready");
            const entries = Array.isArray(registry) ? registry : registry.getAll();
            logStage("registry-read", `entries=${entries.length}`);
            for (const entry of entries) {
                const id = normalizeOptionalString(entry?.id) ?? "";
                if (!id) {
                    continue;
                }
                const provider = normalizeOptionalString(entry?.provider) ?? "";
                if (!provider) {
                    continue;
                }
                if (shouldSuppressBuiltInModel({ provider, id, config: cfg })) {
                    continue;
                }
                const name = normalizeOptionalString(entry?.name ?? id) || id;
                const contextWindow = typeof entry?.contextWindow === "number" && entry.contextWindow > 0
                    ? entry.contextWindow
                    : undefined;
                const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
                const input = Array.isArray(entry?.input) ? entry.input : undefined;
                models.push({ id, name, provider, contextWindow, reasoning, input });
            }
            const supplemental = await augmentModelCatalogWithProviderPlugins({
                config: cfg,
                env: process.env,
                context: {
                    config: cfg,
                    agentDir,
                    env: process.env,
                    entries: [...models],
                },
            });
            if (supplemental.length > 0) {
                const seen = new Set(models.map((entry) => `${normalizeLowercaseStringOrEmpty(entry.provider)}::${normalizeLowercaseStringOrEmpty(entry.id)}`));
                for (const entry of supplemental) {
                    const key = `${normalizeLowercaseStringOrEmpty(entry.provider)}::${normalizeLowercaseStringOrEmpty(entry.id)}`;
                    if (seen.has(key)) {
                        continue;
                    }
                    models.push(entry);
                    seen.add(key);
                }
            }
            logStage("plugin-models-merged", `entries=${models.length}`);
            if (models.length === 0) {
                // If we found nothing, don't cache this result so we can try again.
                if (!readOnly) {
                    modelCatalogPromise = null;
                }
            }
            const sorted = sortModels(models);
            logStage("complete", `entries=${sorted.length}`);
            return sorted;
        }
        catch (error) {
            if (!hasLoggedModelCatalogError) {
                hasLoggedModelCatalogError = true;
                log.warn(`Failed to load model catalog: ${String(error)}`);
            }
            // Don't poison the cache on transient dependency/filesystem issues.
            if (!readOnly) {
                modelCatalogPromise = null;
            }
            if (models.length > 0) {
                return sortModels(models);
            }
            return [];
        }
    };
    if (readOnly) {
        return loadCatalog();
    }
    modelCatalogPromise = loadCatalog();
    return modelCatalogPromise;
}
/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry) {
    return entry?.input?.includes("image") ?? false;
}
/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export function modelSupportsDocument(entry) {
    return entry?.input?.includes("document") ?? false;
}
/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(catalog, provider, modelId) {
    const normalizedProvider = normalizeProviderId(provider);
    const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
    return catalog.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider &&
        normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId);
}
