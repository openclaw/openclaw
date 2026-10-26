import { setImmediate as yieldToGateway } from "node:timers/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type ContextWindowCacheState,
  providerContextTokenCacheKey,
  getContextWindowCaches,
  replaceContextWindowCaches,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import {
  type ModelsConfig,
  resolveAnthropicFixedContextWindow,
  type ContextTokenResolutionParams,
  type ModelContextTokenProjection,
  resolveModelContextTokenProjectionFromCache,
} from "./context-resolution.js";
import {
  beginContextWindowCacheRefresh,
  CONTEXT_WINDOW_RUNTIME_STATE,
} from "./context-runtime-state.js";

const CONTEXT_PROJECTION_BATCH_SIZE = 512;

type ContextWindowModelEntry = {
  id: string;
  provider?: string;
  contextWindow?: number;
  contextTokens?: number;
};

type ContextWindowCatalog = {
  entries: ContextWindowModelEntry[];
  staticEntries?: ContextWindowModelEntry[];
};

type ConfiguredProvider = NonNullable<ModelsConfig["providers"]>[string];
type ConfiguredModel = NonNullable<NonNullable<ConfiguredProvider>["models"]>[number];

function cacheMinimum(cache: Map<string, number>, key: string, contextTokens: number): void {
  const existing = cache.get(key);
  if (existing === undefined || contextTokens < existing) {
    cache.set(key, contextTokens);
  }
}

function contextModelKeys(modelId: string, provider?: string): string[] {
  const keys = [modelId];
  if (provider === undefined) {
    return keys;
  }
  keys.push(providerContextTokenCacheKey(provider, modelId));
  const slash = modelId.indexOf("/");
  const prefixedProvider = slash > 0 ? normalizeProviderId(modelId.slice(0, slash)) : "";
  const bareModelId = slash > 0 ? modelId.slice(slash + 1).trim() : "";
  if (provider && prefixedProvider === provider && bareModelId) {
    keys.push(providerContextTokenCacheKey(provider, bareModelId));
  }
  return keys;
}

function applyDiscoveredContextWindow(
  cache: Map<string, number>,
  model: ContextWindowModelEntry,
): void {
  if (!model.id) {
    return;
  }
  const discoveredContextTokens =
    typeof model.contextTokens === "number"
      ? Math.trunc(model.contextTokens)
      : typeof model.contextWindow === "number"
        ? Math.trunc(model.contextWindow)
        : undefined;
  const contextTokens =
    resolveDiscoveredAnthropicFixedContextWindow(model) ?? discoveredContextTokens;
  if (!contextTokens || contextTokens <= 0) {
    return;
  }

  const provider = model.provider ? normalizeProviderId(model.provider) : "";
  for (const key of contextModelKeys(model.id, provider || undefined)) {
    cacheMinimum(cache, key, contextTokens);
  }
}

function* configuredModels(modelsConfig: ModelsConfig | undefined) {
  for (const [providerId, provider] of Object.entries(modelsConfig?.providers ?? {})) {
    for (const model of provider?.models ?? []) {
      yield { providerId, model };
    }
  }
}

function applyConfiguredContextWindow(params: {
  cache: Map<string, number>;
  windowCache: Map<string, number>;
  providerId: string;
  model: ConfiguredModel;
}): void {
  const { id: modelId, contextTokens, contextWindow } = params.model;
  const configuredValue =
    contextTokens && contextTokens > 0
      ? { cache: params.cache, value: contextTokens }
      : contextWindow && contextWindow > 0
        ? { cache: params.windowCache, value: contextWindow }
        : undefined;
  if (!modelId || !configuredValue) {
    return;
  }
  for (const key of contextModelKeys(modelId, normalizeProviderId(params.providerId))) {
    configuredValue.cache.set(key, configuredValue.value);
  }
}

function resolveDiscoveredAnthropicFixedContextWindow(
  model: ContextWindowModelEntry,
): number | undefined {
  const provider = model.provider ? normalizeProviderId(model.provider) : undefined;
  if (provider) {
    return resolveAnthropicFixedContextWindow(provider, model.id);
  }
  const normalized = normalizeLowercaseStringOrEmpty(model.id);
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const inferredProvider = normalizeProviderId(normalized.slice(0, slash));
  const inferredModel = normalized.slice(slash + 1);
  return inferredProvider === "claude-cli"
    ? resolveAnthropicFixedContextWindow(inferredProvider, inferredModel)
    : undefined;
}

async function projectModels(
  cache: Map<string, number>,
  modelCatalog: ContextWindowCatalog,
  alreadyProcessed = 0,
): Promise<void> {
  let processed = alreadyProcessed;
  for (const models of [modelCatalog.entries, modelCatalog.staticEntries ?? []]) {
    for (const model of models) {
      applyDiscoveredContextWindow(cache, model);
      processed += 1;
      if (processed % CONTEXT_PROJECTION_BATCH_SIZE === 0) {
        await yieldToGateway();
      }
    }
  }
}

const loadPreparedModelCatalogRuntime = () => import("./prepared-model-catalog.js");

function primeConfiguredContextWindowsFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  const caches = getContextWindowCaches();
  for (const model of configuredModels(cfg.models)) {
    applyConfiguredContextWindow({
      cache: caches.configuredTokenCache,
      windowCache: caches.contextWindowCache,
      ...model,
    });
  }
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = cfg;
  return cfg;
}

function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  if (CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig) {
    return CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig;
  }
  const cfg = getRuntimeConfigSnapshot();
  return cfg ? primeConfiguredContextWindowsFromConfig(cfg) : undefined;
}

export function ensureContextWindowCacheLoaded(): Promise<void> {
  if (CONTEXT_WINDOW_RUNTIME_STATE.loadPromise) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const cfg = primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }
  const loadPromise = Promise.resolve()
    .then(async () => {
      let stagedTokenCache = new Map<string, number>();
      try {
        const { loadPreparedModelCatalogOwnerSnapshot } = await loadPreparedModelCatalogRuntime();
        const owner = await loadPreparedModelCatalogOwnerSnapshot({
          config: cfg,
          readOnly: true,
        });
        const discoveredTokenCache = new Map<string, number>();
        await projectModels(discoveredTokenCache, owner.modelCatalog);
        stagedTokenCache = discoveredTokenCache;
      } catch {
        // Static and discovered rows belong to one atomic generation. If its owner fails, keep
        // config overrides only instead of mixing in independently rediscovered static metadata.
      }
      // A refresh supersedes earlier discovery, including its best-effort failure result.
      if (CONTEXT_WINDOW_RUNTIME_STATE.loadPromise === loadPromise) {
        replaceDiscoveredContextTokenCache(stagedTokenCache);
      }
    })
    .catch(() => {
      // Keep lookup best-effort.
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = loadPromise;
  return loadPromise;
}

/**
 * Reuse the Gateway's published catalog generation. Omitting the Gateway binding
 * falls through to a read-only owner whose key hashes the full model config.
 */
export async function prewarmContextWindowCacheAfterReady(params: {
  config: OpenClawConfig;
  isCancelled?: () => boolean;
}): Promise<void> {
  // Post-ready warmup owns a published-owner generation. Do not reuse a request-time
  // load that may have completed before Gateway catalog publication.
  beginContextWindowCacheRefresh();
  if (params.isCancelled?.()) {
    return;
  }
  let published = false;
  const loadPromise = Promise.resolve()
    .then(async () => {
      const { getPublishedPreparedModelCatalogOwnerSnapshot } =
        await loadPreparedModelCatalogRuntime();
      const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
        config: params.config,
        allowGatewaySubagentBinding: true,
      });
      if (!owner) {
        throw new Error("published Gateway model catalog owner is unavailable");
      }
      // Gateway publication intentionally exposes configured/static turn facts. Full catalog
      // inventory is a separate control-plane load and must not run in post-ready warmup.
      const caches: ContextWindowCacheState = {
        configuredTokenCache: new Map(),
        discoveredTokenCache: new Map(),
        contextWindowCache: new Map(),
      };
      let processed = 0;
      for (const model of configuredModels(owner.config.models)) {
        applyConfiguredContextWindow({
          cache: caches.configuredTokenCache,
          windowCache: caches.contextWindowCache,
          ...model,
        });
        processed += 1;
        if (processed % CONTEXT_PROJECTION_BATCH_SIZE === 0) {
          await yieldToGateway();
        }
      }
      await projectModels(caches.discoveredTokenCache, owner.modelCatalog, processed);
      if (params.isCancelled?.()) {
        return;
      }
      replaceContextWindowCaches(caches);
      CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = owner.config;
      published = true;
    })
    .catch(() => {
      // Optional Gateway warmup is best-effort; failed publication can retry on demand.
    })
    .finally(() => {
      // Overlapping optional warmups may publish older metadata until the next refresh.
      if (!published) {
        CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
      }
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = loadPromise;
  await loadPromise;
}

/** Restore configured context limits without acquiring a model catalog. */
export function resetContextWindowCache(cfg: OpenClawConfig): void {
  beginContextWindowCacheRefresh();
  const caches = getContextWindowCaches();
  caches.configuredTokenCache.clear();
  caches.contextWindowCache.clear();
  primeConfiguredContextWindowsFromConfig(cfg);
}

/** Replace cached model context metadata for the active runtime configuration. */
export async function refreshContextWindowCache(cfg: OpenClawConfig): Promise<void> {
  resetContextWindowCache(cfg);
  await ensureContextWindowCacheLoaded();
}

function prepareContextWindowCache(options?: {
  allowAsyncLoad?: boolean;
  skipRuntimeConfigLoad?: boolean;
}) {
  if (options?.skipRuntimeConfigLoad) {
    return;
  }
  if (options?.allowAsyncLoad === false) {
    // Read-only callers still need synchronous config-backed overrides, but they
    // should not start background model discovery.
    primeConfiguredContextWindows();
  } else {
    // Best-effort: kick off loading on demand, but don't block lookups.
    void ensureContextWindowCacheLoaded();
  }
}

export function resolveContextTokensForModel(
  params: ContextTokenResolutionParams,
): number | undefined {
  return resolveModelContextTokenProjection(params).contextTokens;
}

export function resolveModelContextTokenProjection(
  params: ContextTokenResolutionParams,
): ModelContextTokenProjection {
  prepareContextWindowCache({
    allowAsyncLoad: params.allowAsyncLoad,
    skipRuntimeConfigLoad: Boolean(params.cfg) || params.allowCacheLookup === false,
  });
  return resolveModelContextTokenProjectionFromCache(params);
}
