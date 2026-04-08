import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { normalizeProviderId } from "./provider-id.js";

const log = createSubsystemLogger("model-catalog");

export type ModelInputType = "text" | "image" | "document";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type PiSdkModule = typeof import("./pi-model-discovery.js");
type PiRegistryInstance =
  | Array<DiscoveredModel>
  | {
      getAll: () => Array<DiscoveredModel>;
    };
type PiRegistryClassLike = {
  create?: (authStorage: unknown, modelsFile: string) => PiRegistryInstance;
  new (authStorage: unknown, modelsFile: string): PiRegistryInstance;
};

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery-runtime.js");
let importPiSdk = defaultImportPiSdk;
let modelSuppressionPromise: Promise<typeof import("./model-suppression.runtime.js")> | undefined;

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  modelSuppressionPromise ??= import("./model-suppression.runtime.js");
  return modelSuppressionPromise;
}

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

function instantiatePiModelRegistry(
  piSdk: PiSdkModule,
  authStorage: unknown,
  modelsFile: string,
): PiRegistryInstance {
  const Registry = piSdk.ModelRegistry as unknown as PiRegistryClassLike;
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsFile);
  }
  return new Registry(authStorage, modelsFile);
}

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) {
    return modelCatalogPromise;
  }

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const timingEnabled = shouldLogModelCatalogTiming();
    const startMs = timingEnabled ? Date.now() : 0;
    const logStage = (stage: string, extra?: string) => {
      if (!timingEnabled) {
        return;
      }
      const suffix = extra ? ` ${extra}` : "";
      log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
    };
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureOpenClawModelsJson(cfg);
      logStage("models-json-ready");
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      logStage("pi-sdk-imported");
      const agentDir = resolveOpenClawAgentDir();
      const { shouldSuppressBuiltInModel } = await loadModelSuppression();
      logStage("catalog-deps-ready");
      const { join } = await import("node:path");
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      logStage("auth-storage-ready");
      const registry = instantiatePiModelRegistry(
        piSdk,
        authStorage,
        join(agentDir, "models.json"),
      );
      logStage("registry-ready");
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      logStage("registry-read", `entries=${entries.length}`);
      for (const entry of entries) {
        const id = normalizeOptionalString(String(entry?.id ?? "")) ?? "";
        if (!id) {
          continue;
        }
        const provider = normalizeOptionalString(String(entry?.provider ?? "")) ?? "";
        if (!provider) {
          continue;
        }
        if (shouldSuppressBuiltInModel({ provider, id })) {
          continue;
        }
        const name = normalizeOptionalString(String(entry?.name ?? id)) || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input });
      }
      // Merge models from user-configured providers in openclaw.json
      // (`models.providers.<id>.models[]`).
      //
      // The Pi SDK registry above only surfaces bundled providers; without this step,
      // any custom OpenAI-compatible provider declared in `openclaw.json` (e.g. a
      // local MLX server, packycode, lmstudio-style endpoints) is absent from the
      // gateway model catalog. Downstream capability checks like
      // `resolveGatewayModelSupportsImages()` would then return `false` for such
      // models, causing `parseMessageWithAttachments()` to silently drop every
      // image attachment with the warning
      // `parseMessageWithAttachments: N attachment(s) dropped — model does not support images`,
      // even when the user explicitly declared `"input": ["text", "image"]` on the
      // configured model entry.
      //
      // This restores the behavior of the previous `mergeConfiguredOptInProviderModels`
      // helper but without its hardcoded provider allowlist — any provider with a
      // `models[]` array and per-entry `id` is eligible. Fixes #38639.
      const configuredProviders = cfg.models?.providers;
      if (configuredProviders && typeof configuredProviders === "object") {
        const seenForConfigured = new Set(
          models.map(
            (entry) =>
              `${normalizeLowercaseStringOrEmpty(entry.provider)}::${normalizeLowercaseStringOrEmpty(entry.id)}`,
          ),
        );
        for (const [providerKey, providerCfg] of Object.entries(configuredProviders)) {
          if (!providerCfg || typeof providerCfg !== "object") {
            continue;
          }
          const provider = normalizeOptionalString(String(providerKey)) ?? "";
          if (!provider) {
            continue;
          }
          const configuredModels = (providerCfg as { models?: unknown }).models;
          if (!Array.isArray(configuredModels)) {
            continue;
          }
          for (const configuredModel of configuredModels) {
            if (!configuredModel || typeof configuredModel !== "object") {
              continue;
            }
            const idRaw = (configuredModel as { id?: unknown }).id;
            const id = normalizeOptionalString(typeof idRaw === "string" ? idRaw : "") ?? "";
            if (!id) {
              continue;
            }
            const dedupeKey = `${normalizeLowercaseStringOrEmpty(provider)}::${normalizeLowercaseStringOrEmpty(id)}`;
            if (seenForConfigured.has(dedupeKey)) {
              continue;
            }
            if (shouldSuppressBuiltInModel({ provider, id })) {
              continue;
            }
            const rawName = (configuredModel as { name?: unknown }).name;
            const name = normalizeOptionalString(typeof rawName === "string" ? rawName : id) || id;
            const contextWindowRaw = (configuredModel as { contextWindow?: unknown })
              .contextWindow;
            const contextWindow =
              typeof contextWindowRaw === "number" && contextWindowRaw > 0
                ? contextWindowRaw
                : undefined;
            const reasoningRaw = (configuredModel as { reasoning?: unknown }).reasoning;
            const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : undefined;
            const inputRaw = (configuredModel as { input?: unknown }).input;
            const inputFiltered = Array.isArray(inputRaw)
              ? (inputRaw.filter(
                  (item): item is ModelInputType =>
                    item === "text" || item === "image" || item === "document",
                ) as ModelInputType[])
              : undefined;
            const input = inputFiltered && inputFiltered.length > 0 ? inputFiltered : undefined;
            models.push({ id, name, provider, contextWindow, reasoning, input });
            seenForConfigured.add(dedupeKey);
          }
        }
        logStage("configured-providers-merged", `entries=${models.length}`);
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
        const seen = new Set(
          models.map(
            (entry) =>
              `${normalizeLowercaseStringOrEmpty(entry.provider)}::${normalizeLowercaseStringOrEmpty(entry.id)}`,
          ),
        );
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
        modelCatalogPromise = null;
      }

      const sorted = sortModels(models);
      logStage("complete", `entries=${sorted.length}`);
      return sorted;
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("document") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  return catalog.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId,
  );
}
