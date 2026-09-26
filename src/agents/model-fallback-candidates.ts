import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
/** Resolves ordered model and image fallback candidate chains. */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasUtilityModelSeparationMigrationMarker } from "../config/utility-model-separation-migration.js";
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
import { resolveAgentConfig, resolveAgentModelConfigForRuntime } from "./agent-scope-config.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  createModelCandidateCollector,
  resolveModelCandidateChainFromConfig,
  type ModelCandidateChainParams,
} from "./model-fallback-candidates-core.js";
import type { ModelFallbackCandidate, ModelFallbackRouteOrigin } from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-resolve.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

const MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES = 256;
const fallbackCandidateCache = new Map<string, ModelFallbackCandidate[]>();
const fallbackContextIds = new WeakMap<object, number>();
let nextFallbackContextId = 0;
const log = createSubsystemLogger("model-selection");

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
  const { cacheKey, manifestPlugins } = resolveFallbackCandidateContext(params);
  const cached = cacheKey ? fallbackCandidateCache.get(cacheKey) : undefined;
  if (cached) {
    return cached.map((candidate) => Object.assign({}, candidate));
  }
  const candidates = resolveModelCandidateChainFromConfig({ ...params, manifestPlugins });
  if (cacheKey) {
    fallbackCandidateCache.set(
      cacheKey,
      candidates.map((candidate) => Object.assign({}, candidate)),
    );
    pruneMapToMaxSize(fallbackCandidateCache, MAX_FALLBACK_CANDIDATE_CACHE_ENTRIES);
  }
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

function resolveFallbackCandidateContext(params: ModelCandidateChainParams) {
  if (params.manifestPlugins !== undefined) {
    return { cacheKey: null, manifestPlugins: params.manifestPlugins };
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
    requireDefaultDiscoveryContext: params.cfg === undefined,
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
    return { cacheKey: null, manifestPlugins: providerLoadMetadata };
  }
  const registryState = getPluginRegistryState();
  const registry = getPluginRuntimeGenerationRegistry() ?? getPluginRegistryForContext();
  const agentConfig =
    params.cfg && params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const cacheKey = JSON.stringify({
    agentId: params.agentId,
    agentModel: resolveAgentModelConfigForRuntime(agentConfig),
    agentModels: agentConfig?.models,
    provider: params.provider,
    model: params.model,
    requestedRouteResolution: params.requestedRouteResolution,
    allowPluginNormalization: params.allowPluginNormalization,
    fallbacksOverride: params.fallbacksOverride,
    agentsDefaultsModel: params.cfg?.agents?.defaults?.model,
    agentsDefaultsModels: params.cfg?.agents?.defaults?.models,
    utilityModel: params.cfg ? readUtilityModelSetting(params.cfg, params.agentId) : undefined,
    utilityModelSeparation: hasUtilityModelSeparationMigrationMarker(params.cfg),
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
    normalizationMetadataIdentity: providerLoadMetadata
      ? getFallbackContextId(providerLoadMetadata)
      : null,
    pluginRegistryIdentity: registry ? getFallbackContextId(registry) : null,
    pluginRegistryKey: registryState?.key ?? null,
    pluginRegistryVersion: registryState?.activeVersion ?? null,
    pluginWorkspaceDir: workspaceDir ?? null,
  });
  return { cacheKey, manifestPlugins: providerLoadMetadata };
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
