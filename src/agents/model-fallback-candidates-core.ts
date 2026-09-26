/** Resolves candidate order from supplied config/metadata without loading a provider registry. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

export type ModelCandidateChainParams = ModelManifestNormalizationContext & {
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

export function createModelCandidateCollector() {
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

export function resolveModelCandidateChainFromConfig(
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
  addCandidate(
    requestedCandidate,
    "requested",
    params.manifestPlugins !== undefined ? "resolved" : requestedRouteResolution,
  );

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
