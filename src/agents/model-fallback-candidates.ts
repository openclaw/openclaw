import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  getPluginRegistryState,
} from "../plugins/runtime-state.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { hasExactConfiguredProviderModel } from "./configured-provider-model.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type {
  ModelCandidate,
  ModelFallbackCandidate,
  ModelFallbackRouteOrigin,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRefSelection,
  normalizeProviderId,
} from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  buildConfiguredModelCatalog,
  completeModelRefSelection,
  resolveConfiguredModelFallbacks,
  resolveConfiguredModelSelection,
  resolveModelAliasFromPair,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";

const MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES = 256;
const fallbackCandidateCache = new Map<string, ModelFallbackCandidate[]>();
const retainedFallbackCandidateCaches = new WeakMap<object, typeof fallbackCandidateCache>();
const log = createSubsystemLogger("model-selection");

type ModelCandidateChainParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  model: string;
  /** Explicit fallbacks, including an empty list, replace the configured chain. */
  fallbacksOverride?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  /** The target producer records normalization separately from route ownership. */
  requestedModelNormalization?: ModelRefSelection["normalization"];
  /** Planning uses manifest policy before a retained runtime can own executable hooks. */
  allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext;

function createModelCandidateCollector(): {
  candidates: ModelFallbackCandidate[];
  addCandidate: (
    candidate: ModelCandidate,
    routeOrigin: ModelFallbackRouteOrigin,
    routeResolution: ModelFallbackRouteResolution,
  ) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelFallbackCandidate[] = [];

  const addCandidate = (
    candidate: ModelCandidate,
    routeOrigin: ModelFallbackRouteOrigin,
    routeResolution: ModelFallbackRouteResolution,
  ) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = buildModelCatalogRef(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ ...candidate, routeOrigin, routeResolution });
  };

  return {
    candidates,
    addCandidate,
  };
}

export function resolveImageFallbackCandidates(
  params: {
    cfg: OpenClawConfig | undefined;
    defaultProvider: string;
    modelOverride?: string;
  } & ModelManifestNormalizationContext,
): ModelFallbackCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addCandidate } = createModelCandidateCollector();

  const addRaw = (raw: string, routeOrigin: ModelFallbackRouteOrigin) => {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      log.warn(
        `Unresolved image model "${sanitizeForLog(raw)}"; skipped ${routeOrigin} candidate.`,
      );
      return;
    }
    addCandidate(resolved.ref, routeOrigin, "resolved");
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, "requested");
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary, "configured-primary");
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);
  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw, "configured-fallback");
  }
  return candidates;
}

export function resolveImageFallbackDefaultProvider(cfg: OpenClawConfig | undefined): string {
  const configuredPrimary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
  if (configuredPrimary?.trim()) {
    const aliasIndex = buildModelAliasIndex({
      cfg: cfg ?? {},
      defaultProvider: DEFAULT_PROVIDER,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      raw: configuredPrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved?.ref.provider) {
      return resolved.ref.provider;
    }
  }
  return DEFAULT_PROVIDER;
}

export function resolveModelCandidateChain(
  params: ModelCandidateChainParams,
): ModelFallbackCandidate[] {
  const cacheKey = resolveFallbackCandidateCacheKey(params);
  if (!cacheKey) {
    return resolveFallbackCandidatesUncached(params);
  }
  const registry = getPluginRuntimeGenerationRegistry();
  let cache = fallbackCandidateCache;
  if (registry) {
    // Retained registries can share metadata while owning different executable hooks.
    let retainedCache = retainedFallbackCandidateCaches.get(registry);
    if (!retainedCache) {
      retainedCache = new Map();
      retainedFallbackCandidateCaches.set(registry, retainedCache);
    }
    cache = retainedCache;
  }
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.map(cloneModelCandidate);
  }
  const candidates = resolveFallbackCandidatesUncached(params);
  cache.set(cacheKey, candidates.map(cloneModelCandidate));
  pruneMapToMaxSize(cache, MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES);
  return candidates;
}

function cloneModelCandidate(candidate: ModelFallbackCandidate): ModelFallbackCandidate {
  return {
    provider: candidate.provider,
    model: candidate.model,
    routeOrigin: candidate.routeOrigin,
    routeResolution: candidate.routeResolution,
  };
}

function resolveFallbackCandidateCacheKey(params: ModelCandidateChainParams): string | null {
  if (params.manifestPlugins) {
    return null;
  }
  const workspaceDir = getActivePluginRegistryWorkspaceDirFromState();
  const env = process.env;
  const pluginMetadata = getCurrentPluginMetadataSnapshot({
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  const providerLoadMetadata = getCurrentPluginMetadataSnapshot({
    config: params.cfg,
    env,
    workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  if (
    isPluginProvidersLoadInFlight({
      config: params.cfg,
      workspaceDir,
      env,
      ...(providerLoadMetadata ? { pluginMetadataSnapshot: providerLoadMetadata } : {}),
      activate: false,
    })
  ) {
    return null;
  }
  const registryState = getPluginRegistryState();
  const agentConfig =
    params.cfg && params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return JSON.stringify({
    agentId: params.agentId,
    agentModel: agentConfig?.model,
    agentModels: agentConfig?.models,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: params.requestedRouteResolution,
    requestedModelNormalization: params.requestedModelNormalization ?? "pending",
    allowPluginNormalization: params.allowPluginNormalization !== false,
    fallbacksOverride: params.fallbacksOverride,
    agentsDefaultsModel: params.cfg?.agents?.defaults?.model,
    agentsDefaultsModels: params.cfg?.agents?.defaults?.models,
    modelProviders: resolveFallbackCandidateModelProviderCacheParts(params.cfg),
    pluginControlPlane: resolvePluginControlPlaneFingerprint({
      config: params.cfg,
      env,
      workspaceDir,
    }),
    pluginMetadataFingerprint: pluginMetadata?.configFingerprint ?? null,
    pluginRegistryKey: registryState?.key ?? null,
    pluginRegistryVersion: registryState?.activeVersion ?? null,
    pluginWorkspaceDir: workspaceDir ?? null,
  });
}

function resolveFallbackCandidateModelProviderCacheParts(cfg: OpenClawConfig | undefined): unknown {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  return Object.entries(providers).map(([providerId, providerConfig]) => ({
    providerId,
    api: typeof providerConfig?.api === "string" ? providerConfig.api : undefined,
    models: Array.isArray(providerConfig?.models)
      ? providerConfig.models
          .map((entry) => (typeof entry?.id === "string" ? entry.id : undefined))
          .filter((id): id is string => id !== undefined)
      : [],
  }));
}

function resolveFallbackCandidatesUncached(
  params: ModelCandidateChainParams,
): ModelFallbackCandidate[] {
  const allowRuntimeNormalization = params.allowPluginNormalization !== false;
  const primarySelection = params.cfg
    ? resolveConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.agentId,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const primary = primarySelection?.ref ?? null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
  const requestedModel = normalizeOptionalString(params.model);
  const modelRaw = requestedModel || defaultModel;
  const allowPluginModelAliases =
    allowRuntimeNormalization && params.cfg?.plugins?.enabled !== false;
  const configuredCatalog = buildConfiguredModelCatalog({
    cfg: params.cfg ?? {},
    manifestPlugins: params.manifestPlugins,
  });
  const normalizeSelection = (selection: ModelRefSelection, allowPluginNormalization: boolean) =>
    completeModelRefSelection(selection, {
      ...params,
      configuredCatalog,
      allowPluginNormalization,
    });
  const normalizePrimary = () =>
    primarySelection ? normalizeSelection(primarySelection, allowPluginModelAliases) : null;
  const requestedPrimary =
    !requestedModel && normalizeProviderId(providerRaw) === defaultProvider
      ? normalizePrimary()
      : null;
  const normalizedPrimary =
    requestedPrimary ??
    normalizeSelection(
      {
        ref: { provider: providerRaw, model: modelRaw },
        normalization: params.requestedModelNormalization ?? "pending",
      },
      allowRuntimeNormalization,
    );
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    agentId: params.agentId,
    defaultProvider,
    allowPluginNormalization: allowPluginModelAliases,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addCandidate } = createModelCandidateCollector();
  const requestedRouteResolution = params.requestedRouteResolution ?? "raw";
  let requestedCandidate = normalizedPrimary;
  const exactRequestedRouteConfigured =
    requestedPrimary !== null ||
    hasExactConfiguredProviderModel({
      cfg: params.cfg,
      provider: normalizedPrimary.provider,
      model: normalizedPrimary.model,
    }) ||
    aliasIndex.byKey.has(buildModelCatalogRef(normalizedPrimary.provider, normalizedPrimary.model));
  // Persisted legacy pairs may still contain aliases. Prepared routes already
  // own their provider, so reparsing them can silently select another route.
  if (requestedRouteResolution === "raw" && !exactRequestedRouteConfigured) {
    requestedCandidate =
      resolveModelAliasFromPair({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: providerRaw,
        model: modelRaw,
        defaultProvider,
        aliasIndex,
        // The alias index owns normalized targets; a parse miss must not rerun hooks.
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      }) ?? normalizedPrimary;
  }
  addCandidate(requestedCandidate, "requested", requestedRouteResolution);

  const modelFallbacks =
    params.fallbacksOverride !== undefined
      ? params.fallbacksOverride
      : params.cfg
        ? resolveConfiguredModelFallbacks({ cfg: params.cfg, agentId: params.agentId })
        : [];
  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      agentId: params.agentId,
      raw,
      defaultProvider,
      aliasIndex,
      allowPluginNormalization: allowPluginModelAliases,
      manifestPlugins: params.manifestPlugins,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addCandidate(resolved.ref, "configured-fallback", "resolved");
  }

  const configuredPrimary =
    params.fallbacksOverride === undefined ? (requestedPrimary ?? normalizePrimary()) : null;
  if (configuredPrimary) {
    addCandidate(configuredPrimary, "configured-primary", "resolved");
  }
  return candidates;
}
