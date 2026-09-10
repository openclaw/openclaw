import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
/** Resolves ordered model and image fallback candidate chains. */
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
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import {
  allowsPluginModelNormalization,
  hasExactConfiguredProviderModel,
} from "./configured-provider-model.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type {
  ModelCandidate,
  ModelFallbackCandidate,
  ModelFallbackRouteOrigin,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import {
  type ModelManifestNormalizationContext,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelFallbacks,
  resolveConfiguredModelRef,
  resolveModelAliasFromPair,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

const MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES = 256;
const fallbackCandidateCache = new Map<string, ModelFallbackCandidate[]>();
const fallbackContextIds = new WeakMap<object, number>();
let nextFallbackContextId = 0;
const log = createSubsystemLogger("model-selection");

type ModelCandidateChainParams = ModelManifestNormalizationContext & {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  model: string;
  /** An explicit list, including empty, replaces the configured model fallbacks. */
  fallbacksOverride?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  /** Pure admission planning may use manifest policy without entering provider runtime hooks. */
  allowPluginNormalization?: boolean;
};

function createModelCandidateCollector() {
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
    const key = JSON.stringify([candidate.provider, candidate.model]);
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
    modelOverride?: string;
  } & ModelManifestNormalizationContext,
): ModelFallbackCandidate[] {
  const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
  let defaultProvider = DEFAULT_PROVIDER;
  if (primary?.trim()) {
    const primaryAliasIndex = buildModelAliasIndex({
      cfg: params.cfg ?? {},
      defaultProvider: DEFAULT_PROVIDER,
      manifestPlugins: params.manifestPlugins,
    });
    const resolvedPrimary = resolveModelRefFromString({
      cfg: params.cfg,
      raw: primary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex: primaryAliasIndex,
      manifestPlugins: params.manifestPlugins,
    });
    defaultProvider = resolvedPrimary?.ref.provider || DEFAULT_PROVIDER;
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addCandidate } = createModelCandidateCollector();

  const addRaw = (raw: string, routeOrigin: ModelFallbackRouteOrigin) => {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider,
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
  } else if (primary?.trim()) {
    addRaw(primary, "configured-primary");
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);
  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw, "configured-fallback");
  }
  return candidates;
}

export function resolveModelCandidateChain(
  params: ModelCandidateChainParams,
): ModelFallbackCandidate[] {
  const cacheKey = resolveFallbackCandidateCacheKey(params);
  if (!cacheKey) {
    return resolveFallbackCandidatesUncached(params);
  }
  const cached = fallbackCandidateCache.get(cacheKey);
  if (cached) {
    return cached.map((candidate) => Object.assign({}, candidate));
  }
  const candidates = resolveFallbackCandidatesUncached(params);
  fallbackCandidateCache.set(
    cacheKey,
    candidates.map((candidate) => Object.assign({}, candidate)),
  );
  pruneMapToMaxSize(fallbackCandidateCache, MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES);
  return candidates;
}

function getFallbackContextId(value: object): number {
  const existing = fallbackContextIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextFallbackContextId++;
  fallbackContextIds.set(value, id);
  return id;
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
  const registry = getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext();
  const agentConfig =
    params.cfg && params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return JSON.stringify({
    agentId: params.agentId,
    agentModel: agentConfig?.model,
    agentModels: agentConfig?.models,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: params.requestedRouteResolution,
    allowPluginNormalization: params.allowPluginNormalization,
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
    // Fingerprints omit executable hooks and narrowed metadata views. Weak ids
    // isolate both without retaining retired registries or growing the cache bound.
    pluginMetadataIdentity: pluginMetadata ? getFallbackContextId(pluginMetadata) : null,
    pluginRegistryIdentity: registry ? getFallbackContextId(registry) : null,
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
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        agentId: params.agentId,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: false,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(params.provider) || defaultProvider;
  const modelRaw = normalizeOptionalString(params.model) || defaultModel;
  const allowPluginModelAliases =
    params.allowPluginNormalization !== false && params.cfg?.plugins?.enabled !== false;
  const requestedRouteResolution = params.requestedRouteResolution ?? "raw";
  const normalizedPrimary =
    requestedRouteResolution === "resolved"
      ? { provider: normalizeProviderId(providerRaw), model: modelRaw }
      : normalizeModelRef(providerRaw, modelRaw, {
          allowPluginNormalization:
            params.allowPluginNormalization !== false &&
            allowsPluginModelNormalization({
              cfg: params.cfg,
              provider: providerRaw,
              model: modelRaw,
            }),
          manifestPlugins: params.manifestPlugins,
        });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    agentId: params.agentId,
    defaultProvider,
    allowPluginNormalization: allowPluginModelAliases,
    manifestPlugins: params.manifestPlugins,
  });
  const { candidates, addCandidate } = createModelCandidateCollector();
  let requestedCandidate = normalizedPrimary;
  const exactRequestedRouteConfigured =
    hasExactConfiguredProviderModel({
      cfg: params.cfg,
      provider: normalizedPrimary.provider,
      model: normalizedPrimary.model,
    }) || aliasIndex.byKey.has(modelKey(normalizedPrimary.provider, normalizedPrimary.model));
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
        allowPluginNormalization:
          params.allowPluginNormalization !== false &&
          allowsPluginModelNormalization({
            cfg: params.cfg,
            provider: providerRaw,
            model: modelRaw,
          }),
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

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    // Primary resolution owns static normalization; refine only through its runtime hook.
    let model = primary.model;
    if (
      allowPluginModelAliases &&
      allowsPluginModelNormalization({ cfg: params.cfg, ...primary })
    ) {
      model =
        normalizeProviderModelIdWithRuntime({
          provider: primary.provider,
          context: { provider: primary.provider, modelId: model },
        }) ?? model;
    }
    addCandidate({ ...primary, model }, "configured-primary", "resolved");
  }
  return candidates;
}
