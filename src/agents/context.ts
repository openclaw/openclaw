import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { resolveProjectedSessionContextTokenBudget } from "../config/sessions/context-token-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  applyConfiguredContextWindows,
  prepareContextWindowCaches,
  prepareDiscoveredContextTokenCache,
} from "./context-cache-projection.js";
import {
  getContextWindowCaches,
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  replaceContextWindowCaches,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import {
  type ContextTokenResolutionParams,
  type ModelContextTokenProjection,
  resolveConfiguredContextTokenLimits,
  resolveModelContextTokenProjectionFromCache,
} from "./context-resolution.js";
import {
  beginContextWindowCacheRefresh,
  CONTEXT_WINDOW_RUNTIME_STATE,
} from "./context-runtime-state.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelContextWindowProfile } from "./model-context-window.js";
import type { LoadPreparedModelCatalogParams } from "./prepared-model-catalog.js";

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
      if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
        return;
      }
      let stagedTokenCache = new Map<string, number>();
      try {
        const { loadPreparedModelCatalogOwnerSnapshot } = await loadPreparedModelCatalogRuntime();
        const owner = await loadPreparedModelCatalogOwnerSnapshot({
          config: cfg,
          readOnly: true,
        });
        if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
          return;
        }
        stagedTokenCache = await prepareDiscoveredContextTokenCache({
          modelCatalog: owner.modelCatalog,
          assertCurrent: () => {
            if (CONTEXT_WINDOW_RUNTIME_STATE.generation !== generation) {
              throw new Error("context window cache generation was superseded");
            }
          },
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
    if (shouldStop()) {
      return;
    }
    const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
      config: params.config,
      allowGatewaySubagentBinding: true,
    });
    if (!owner) {
      throw new Error("published Gateway model catalog owner is unavailable");
    }
    if (shouldStop()) {
      return;
    }
    // Consume only accepted inventory; this passive read does not acquire or renew it.
    // A retired owner cannot lend another account's limits during projection yields.
    const modelCatalog = owner.readFullModelCatalog?.() ?? owner.modelCatalog;
    const isCurrent = () =>
      !shouldStop() &&
      owner.isCurrent() &&
      (owner.readFullModelCatalog?.() ?? owner.modelCatalog) === modelCatalog;
    if (!isCurrent()) {
      return;
    }
    const caches = await prepareContextWindowCaches({
      config: owner.config,
      modelCatalog,
      assertCurrent: () => {
        if (!isCurrent()) {
          throw new Error("context window cache prewarm cancelled");
        }
      },
    });
    if (!isCurrent()) {
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

export async function waitForContextWindowCacheLoad(options?: {
  timeoutMs?: number;
}): Promise<"idle" | "loaded" | "timeout"> {
  const promise = CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  if (
    !promise ||
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration !== CONTEXT_WINDOW_RUNTIME_STATE.generation
  ) {
    return "idle";
  }

  const timeoutMs = Math.max(0, Math.trunc(options?.timeoutMs ?? 250));
  if (timeoutMs === 0) {
    return "timeout";
  }

  return (await settlesWithin(promise, timeoutMs)) ? "loaded" : "timeout";
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

export function lookupContextTokens(
  modelId?: string,
  options?: { allowAsyncLoad?: boolean; skipRuntimeConfigLoad?: boolean },
): number | undefined {
  if (!modelId) {
    return undefined;
  }
  prepareContextWindowCache(options);
  return minPositiveContextTokens(
    lookupCachedContextTokens(modelId),
    lookupCachedContextWindow(modelId),
  );
}

export function resolveContextTokensForModel(
  params: ContextTokenResolutionParams,
): number | undefined {
  return resolveModelContextTokenProjection(params).contextTokens;
}

export function resolveModelContextTokenProjection(
  params: ContextTokenResolutionParams,
): ModelContextTokenProjection {
  const nativeRuntime = normalizeLowercaseStringOrEmpty(params.nativeRuntime);
  if (!nativeRuntime || nativeRuntime === "openclaw") {
    prepareContextWindowCache({
      allowAsyncLoad: params.allowAsyncLoad,
      skipRuntimeConfigLoad: Boolean(params.cfg),
    });
  }
  return resolveModelContextTokenProjectionFromCache(params);
}

type ContextBudgetPreparationParams = ContextTokenResolutionParams &
  Pick<LoadPreparedModelCatalogParams, "agentId" | "agentDir" | "workspaceDir" | "env"> & {
    profileId?: string | null;
    contextWindow?: string;
    route?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
    knownContextBudget?: ReturnType<typeof resolveProjectedSessionContextTokenBudget>;
  };

export async function resolveContextTokenBudgetForModel(
  params: ContextBudgetPreparationParams,
): Promise<ModelContextTokenProjection> {
  let input = { ...params, allowAsyncLoad: false };
  // A provider/model cache has no account or transport binding; this operation consumes owned facts.
  let current = resolveModelContextTokenProjectionFromCache(
    input,
    () => undefined,
    () => undefined,
  );
  const discardUnacceptedModelMetadata = () => {
    input = {
      ...input,
      modelContextTokens: undefined,
      modelContextWindow: undefined,
      modelContextWindowSource: undefined,
    };
    current = resolveModelContextTokenProjectionFromCache(
      input,
      () => undefined,
      () => undefined,
    );
  };
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return current;
  }
  try {
    const runtime = await loadPreparedModelCatalogRuntime();
    const request = {
      config: params.cfg ?? getRuntimeConfig(),
      agentId: params.agentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
    };
    input = { ...input, cfg: request.config };
    current = resolveModelContextTokenProjectionFromCache(
      input,
      () => undefined,
      () => undefined,
    );
    // Accounting must stay bound to its producing configuration across reloads.
    const published = runtime.getPreparedModelCatalogOwnerSnapshot(request);
    const nativeRuntime = normalizeLowercaseStringOrEmpty(params.nativeRuntime);
    const { createSessionContextCapacityResolver } = await import("./session-context-capacity.js");
    const capacity = createSessionContextCapacityResolver(published)(provider, model, {
      nativeRuntime: nativeRuntime && nativeRuntime !== "openclaw" ? nativeRuntime : undefined,
      profileId: params.profileId,
      contextWindow: params.contextWindow,
      route: params.route,
    });
    if (capacity?.unacceptedModelMetadata) {
      discardUnacceptedModelMetadata();
    }
    if (capacity?.state === "ready") {
      const projection =
        capacity.synthetic && current.source !== "fallback"
          ? current
          : resolveModelContextTokenProjectionFromCache(
              {
                ...input,
                modelContextTokens: capacity.synthetic ? undefined : capacity.contextTokens,
                modelContextWindow: capacity.contextTokens,
                modelContextWindowSource: capacity.synthetic ? "synthetic" : undefined,
              },
              () => undefined,
              () => undefined,
            );
      const contextTokens = minPositiveContextTokens(
        projection.contextTokens,
        current.source === "fallback" ? undefined : current.contextTokens,
        capacity.contextTokenLimit,
      );
      return {
        ...projection,
        contextTokens,
        ...(capacity.contextTokensSource && projection.contextTokensSource !== "synthetic"
          ? { contextTokensSource: capacity.contextTokensSource }
          : {}),
      };
    }
    if (
      published ||
      params.profileId !== undefined ||
      params.route ||
      (nativeRuntime && nativeRuntime !== "openclaw") ||
      (params.knownContextBudget && params.knownContextBudget.contextTokensSource !== "synthetic")
    ) {
      return current;
    }
    const catalog = await runtime.loadPreparedModelCatalogSnapshot({
      ...request,
      readOnly: true,
      providerDiscoveryProviderIds: [provider],
      scopedLiveProviderDiscovery: false,
    });
    const entries = [...catalog.entries, ...(catalog.staticEntries ?? [])].filter(
      (candidate) => !candidate.nativeRuntime,
    );
    if (
      findModelInCatalog(
        entries.filter((candidate) => candidate.contextCapacitySource === "unaccepted-starter"),
        provider,
        model,
      )
    ) {
      discardUnacceptedModelMetadata();
    }
    const entry = findModelInCatalog(
      entries.filter((candidate) => candidate.contextCapacitySource !== "unaccepted-starter"),
      provider,
      model,
    );
    const profile = resolveModelContextWindowProfile({
      catalogEntry: entry,
      selected: params.contextWindow,
    });
    if (!entry) {
      return current;
    }
    // Fresh catalog facts replace an unbound cache estimate; only caller/configuration caps remain.
    current = resolveModelContextTokenProjectionFromCache(
      { ...input, cfg: request.config },
      () => undefined,
      () => undefined,
    );
    const projection = resolveModelContextTokenProjectionFromCache(
      {
        ...input,
        cfg: request.config,
        modelContextWindow: profile.contextTokens,
        modelContextWindowSource: profile.contextWindow ? undefined : entry.contextWindowSource,
        modelContextTokens: entry.contextTokens,
      },
      () => undefined,
      () => undefined,
    );
    const { fixedContextWindow } = resolveConfiguredContextTokenLimits({
      ...input,
      cfg: request.config,
      provider,
      model,
    });
    const promptTokens = asPositiveFiniteNumber(entry.contextTokens);
    const contextTokenLimit =
      promptTokens !== undefined || profile.contextWindow
        ? minPositiveContextTokens(
            promptTokens,
            profile.contextWindow
              ? profile.contextTokens
              : (fixedContextWindow ??
                  (entry.contextWindowSource === "synthetic" ? undefined : profile.contextTokens)),
          )
        : undefined;
    return {
      ...projection,
      ...(profile.contextWindows && projection.contextTokensSource !== "synthetic"
        ? { contextTokensSource: "resolved" as const }
        : {}),
      contextTokens: minPositiveContextTokens(
        projection.contextTokens,
        current.source === "fallback" ? undefined : current.contextTokens,
        contextTokenLimit,
      ),
    };
  } catch {
    return current;
  }
}
