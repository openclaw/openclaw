import { getDetectedProviderIds } from "../commands/providers/detection.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { discoverSupplementalModels } from "./supplemental-models.js";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery.js");
let importPiSdk = defaultImportPiSdk;

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

/**
 * Invalidate the cached model catalog so the next call to
 * `loadModelCatalog()` re-reads `models.json` from disk.
 * Safe to call in production (e.g. after auth login refreshes models.json).
 */
export function invalidateModelCatalogCache(): void {
  modelCatalogPromise = null;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
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
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = resolveOpenClawAgentDir();
      const { join } = await import("node:path");
      const authStorage = new piSdk.AuthStorage(join(agentDir, "auth.json"));
      const registry = new piSdk.ModelRegistry(authStorage, join(agentDir, "models.json")) as
        | {
            getAll: () => Array<DiscoveredModel>;
          }
        | Array<DiscoveredModel>;
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
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

      // Discover supplemental models from provider APIs (Anthropic, OpenAI).
      // These fill gaps in pi-ai's static catalog. Dedup by id ensures no
      // conflicts when pi-ai already includes a model.
      const seen = new Set(models.map((m) => m.id));
      try {
        const supplemental = await discoverSupplementalModels({ agentDir });
        for (const sup of supplemental) {
          if (!seen.has(sup.id)) {
            models.push(sup);
            seen.add(sup.id);
          }
        }
      } catch {
        // Discovery failed — continue with existing models only.
      }

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
      }

      return sortModels(models);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        console.warn(`[model-catalog] Failed to load model catalog: ${String(error)}`);
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
 * Load models from the catalog, filtered to only include models from detected providers.
 * This ensures users only see models they can actually use.
 */
export async function loadAvailableModels(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  const cfg = params?.config ?? loadConfig();
  const catalog = await loadModelCatalog({ config: cfg, useCache: params?.useCache });

  // Get detected provider IDs
  const detectedProviders = new Set(getDetectedProviderIds(cfg).map((id) => id.toLowerCase()));

  // If no providers detected, return empty (or all if detection isn't working)
  if (detectedProviders.size === 0) {
    return catalog;
  }

  // Filter to only include models from detected providers
  return catalog.filter((entry) => detectedProviders.has(entry.provider.toLowerCase()));
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}

/**
 * Date-suffix pattern for versioned/snapshot model IDs.
 * Matches IDs ending with `-YYYYMMDD` or `-YYYY-MM-DD`.
 */
const DATE_SUFFIX_RE = /-\d{8}$|-\d{4}-\d{2}-\d{2}$/;

/**
 * Check whether a catalog entry represents the "latest" (canonical) version
 * of a model rather than a date-pinned snapshot.
 *
 * Models whose ID ends with a date stamp (e.g. `claude-opus-4-5-20251101`,
 * `gpt-4o-2024-11-20`) are considered snapshots and excluded by this filter.
 */
export function isLatestModel(entry: ModelCatalogEntry): boolean {
  return !DATE_SUFFIX_RE.test(entry.id);
}

/**
 * Filter a catalog to only include "latest" (canonical / non-dated) models.
 * Useful for showing users a concise list without redundant snapshots.
 */
export function getLatestModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter(isLatestModel);
}
