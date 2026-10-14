import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import {
  applyConfiguredContextWindows,
  prepareContextWindowCaches,
  prepareDiscoveredContextTokenCache,
} from "./context-cache-projection.js";
import {
  getContextWindowCaches,
  replaceContextWindowCaches,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import {
  type ContextTokenResolutionParams,
  type ModelContextTokenProjection,
  resolveModelContextTokenProjectionFromCache,
} from "./context-resolution.js";
import {
  beginContextWindowCacheRefresh,
  CONTEXT_WINDOW_RUNTIME_STATE,
} from "./context-runtime-state.js";

const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};
const loadPreparedModelCatalogRuntime = () => import("./prepared-model-catalog.js");

function primeConfiguredContextWindowsFromConfig(cfg: OpenClawConfig): OpenClawConfig {
  const caches = getContextWindowCaches();
  applyConfiguredContextWindows({
    cache: caches.configuredTokenCache,
    windowCache: caches.contextWindowCache,
    modelsConfig: cfg.models,
  });
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = cfg;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
  return cfg;
}

function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  if (CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig) {
    return primeConfiguredContextWindowsFromConfig(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig);
  }
  if (Date.now() < CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs) {
    return undefined;
  }
  try {
    return primeConfiguredContextWindowsFromConfig(getRuntimeConfig());
  } catch {
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures += 1;
    const backoffMs = computeBackoff(
      CONFIG_LOAD_RETRY_POLICY,
      CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures,
    );
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
    // If config can't be loaded, leave cache empty and retry after backoff.
    return undefined;
  }
}

export function ensureContextWindowCacheLoaded(cfgOverride?: OpenClawConfig): Promise<void> {
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  if (
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise &&
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration === generation
  ) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const cfg = cfgOverride
    ? primeConfiguredContextWindowsFromConfig(cfgOverride)
    : primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = Promise.resolve()
    .then(async () => {
      let stagedTokenCache = new Map<string, number>();
      try {
        const { loadPreparedModelCatalogOwnerSnapshot } = await loadPreparedModelCatalogRuntime();
        const owner = await loadPreparedModelCatalogOwnerSnapshot({
          config: cfg,
          readOnly: true,
        });
        stagedTokenCache = await prepareDiscoveredContextTokenCache({
          modelCatalog: owner.modelCatalog,
        });
      } catch {
        // Static and discovered rows belong to one atomic generation. If its owner fails, keep
        // config overrides only instead of mixing in independently rediscovered static metadata.
      }
      if (CONTEXT_WINDOW_RUNTIME_STATE.generation === generation) {
        replaceDiscoveredContextTokenCache(stagedTokenCache);
      }
    })
    .catch(() => {
      // Keep lookup best-effort.
    });
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
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
  const generation = CONTEXT_WINDOW_RUNTIME_STATE.generation;
  const shouldStop = () =>
    CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation || params.isCancelled?.() === true;
  if (shouldStop()) {
    return;
  }
  let published = false;
  const loadPromise = (async () => {
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
    const caches = await prepareContextWindowCaches({
      config: owner.config,
      modelCatalog: owner.modelCatalog,
    });
    // Superseded projections may finish; only publication needs the current generation.
    if (shouldStop()) {
      return;
    }
    replaceContextWindowCaches(caches);
    CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = owner.config;
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
    published = true;
  })();
  const trackedLoadPromise = loadPromise.catch(() => {});
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = trackedLoadPromise;
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = generation;
  try {
    await loadPromise;
  } catch {
    // Optional Gateway warmup is best-effort; request-time loading remains exact.
  } finally {
    if (
      !published &&
      CONTEXT_WINDOW_RUNTIME_STATE.generation === generation &&
      CONTEXT_WINDOW_RUNTIME_STATE.loadPromise === trackedLoadPromise
    ) {
      CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
      CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = null;
    }
  }
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
