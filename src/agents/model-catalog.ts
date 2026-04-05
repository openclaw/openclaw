import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
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

const NON_PI_NATIVE_MODEL_PROVIDERS = new Set(["arcee", "deepseek", "kilocode", "ollama"]);

function shouldLogModelCatalogTiming(): boolean {
  return process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";
}

function loadModelSuppression() {
  modelSuppressionPromise ??= import("./model-suppression.runtime.js");
  return modelSuppressionPromise;
}

function normalizeConfiguredModelInput(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readConfiguredOptInProviderModels(config: OpenClawConfig): ModelCatalogEntry[] {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const out: ModelCatalogEntry[] = [];
  for (const [providerRaw, providerValue] of Object.entries(providers)) {
    const provider = providerRaw.toLowerCase().trim();
    if (!NON_PI_NATIVE_MODEL_PROVIDERS.has(provider)) {
      continue;
    }
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }

    const configuredModels = (providerValue as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }

    for (const configuredModel of configuredModels) {
      if (!configuredModel || typeof configuredModel !== "object") {
        continue;
      }
      const idRaw = (configuredModel as { id?: unknown }).id;
      if (typeof idRaw !== "string") {
        continue;
      }
      const id = idRaw.trim();
      if (!id) {
        continue;
      }
      const rawName = (configuredModel as { name?: unknown }).name;
      const name = (typeof rawName === "string" ? rawName : id).trim() || id;
      const contextWindowRaw = (configuredModel as { contextWindow?: unknown }).contextWindow;
      const contextWindow =
        typeof contextWindowRaw === "number" && contextWindowRaw > 0 ? contextWindowRaw : undefined;
      const reasoningRaw = (configuredModel as { reasoning?: unknown }).reasoning;
      const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : undefined;
      const input = normalizeConfiguredModelInput((configuredModel as { input?: unknown }).input);
      out.push({ id, name, provider, contextWindow, reasoning, input });
    }
  }

  return out;
}

function mergeConfiguredOptInProviderModels(params: {
  config: OpenClawConfig;
  models: ModelCatalogEntry[];
}): void {
  const configured = readConfiguredOptInProviderModels(params.config);
  if (configured.length === 0) {
    return;
  }

  const seen = new Set(
    params.models.map(
      (entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
    ),
  );

  for (const entry of configured) {
    const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
    if (seen.has(key)) {
      continue;
    }
    params.models.push(entry);
    seen.add(key);
  }
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
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
          continue;
        }
        if (shouldSuppressBuiltInModel({ provider, id })) {
          continue;
        }
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input });
      }
      mergeConfiguredOptInProviderModels({ config: cfg, models });
      logStage("configured-models-merged", `entries=${models.length}`);
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
            (entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
          ),
        );
        for (const entry of supplemental) {
          const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
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
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
