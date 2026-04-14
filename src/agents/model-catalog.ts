import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { normalizeProviderId } from "./provider-id.js";

const log = createSubsystemLogger("model-catalog");

export type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type PiSdkModule = typeof import("./pi-model-discovery-runtime.js");
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

function getCatalogEntryKey(provider: string, id: string): string {
  return `${normalizeProviderId(provider)}::${normalizeLowercaseStringOrEmpty(id)}`;
}

function appendCatalogEntryIfAbsent(
  entries: ModelCatalogEntry[],
  seen: Set<string>,
  entry: ModelCatalogEntry,
): void {
  const key = getCatalogEntryKey(entry.provider, entry.id);
  if (seen.has(key)) {
    return;
  }
  entries.push(entry);
  seen.add(key);
}

function resolveConfiguredCatalogEntries(config?: OpenClawConfig): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const [providerKey, provider] of Object.entries(config?.models?.providers ?? {})) {
    const normalizedProvider = normalizeProviderId(providerKey);
    if (!normalizedProvider) {
      continue;
    }
    for (const model of provider?.models ?? []) {
      const id = normalizeOptionalString(model?.id) ?? "";
      if (!id) {
        continue;
      }
      const name = normalizeOptionalString(model?.name ?? id) || id;
      const contextWindow =
        typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined;
      entries.push({
        id,
        name,
        provider: normalizedProvider,
        contextWindow,
        reasoning: typeof model?.reasoning === "boolean" ? model.reasoning : undefined,
        input: Array.isArray(model?.input) ? (model.input as ModelInputType[]) : undefined,
      });
    }
  }
  return entries;
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
    const seenModelKeys = new Set<string>();
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
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        appendCatalogEntryIfAbsent(models, seenModelKeys, {
          id,
          name,
          provider,
          contextWindow,
          reasoning,
          input,
        });
      }
      for (const entry of resolveConfiguredCatalogEntries(cfg)) {
        // Gateway capability checks must see explicitly configured provider models
        // even when Pi discovery omits them from the runtime registry.
        appendCatalogEntryIfAbsent(models, seenModelKeys, entry);
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
        for (const entry of supplemental) {
          appendCatalogEntryIfAbsent(models, seenModelKeys, entry);
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
