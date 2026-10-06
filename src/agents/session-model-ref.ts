// Resolves persisted session model metadata without loading Gateway projections.
import { resolveSessionModelOverrideRouteResolution } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  inferUniqueProviderFromConfiguredModels,
  normalizeStoredOverrideModel,
  type ModelManifestNormalizationContext,
  parseModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

type SessionModelResolutionOptions = ModelManifestNormalizationContext & {
  allowPluginNormalization?: boolean;
  configuredDefaultModelByAgent?: Map<string, ReturnType<typeof resolveDefaultModelForAgent>>;
};

type SessionModelEntry =
  | SessionEntry
  | Pick<
      SessionEntry,
      | "model"
      | "modelProvider"
      | "modelOverride"
      | "providerOverride"
      | "modelOverrideRouteResolution"
      | "modelOverrideFallbackOriginProvider"
      | "modelOverrideFallbackOriginModel"
    >;

/** Keep prepared host metadata outside the published session-model resolver contract. */
export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  return resolveSessionModelRefCore(cfg, entry, agentId, {
    allowPluginNormalization: options?.allowPluginNormalization,
  });
}

export function resolveSessionConfiguredDefault(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: SessionModelResolutionOptions,
): { provider: string; model: string } {
  const defaults = options?.configuredDefaultModelByAgent;
  const defaultKey =
    defaults &&
    `${agentId ? normalizeAgentId(agentId) : ""}\0${options?.allowPluginNormalization !== false}`;
  let resolved = defaultKey ? defaults?.get(defaultKey) : undefined;
  if (!resolved) {
    resolved = resolveDefaultModelForAgent({
      cfg,
      agentId,
      allowPluginNormalization: options?.allowPluginNormalization,
      manifestPlugins: options?.manifestPlugins,
    });
    if (defaultKey) {
      defaults?.set(defaultKey, resolved);
    }
  }
  return resolved;
}

function resolveSessionModelRefCore(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: SessionModelResolutionOptions,
): { provider: string; model: string } {
  const overrideRouteResolution = resolveSessionModelOverrideRouteResolution(entry);
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    routeResolution: overrideRouteResolution,
  });
  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    return resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      overrideRouteResolution,
      allowPluginNormalization: options?.allowPluginNormalization,
      manifestPlugins: options?.manifestPlugins,
    })!;
  }
  const resolved = resolveSessionConfiguredDefault(cfg, agentId, options);

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    // Runtime fields record the previous run. Agent-scoped selection must use
    // current config or an explicit override; legacy callers without an agent
    // still use the persisted pair as their fallback selection context.
    runtimeProvider: agentId ? undefined : entry?.modelProvider,
    runtimeModel: agentId ? undefined : entry?.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    overrideRouteResolution,
    allowPluginNormalization: options?.allowPluginNormalization,
    manifestPlugins: options?.manifestPlugins,
  });
  return persisted ?? resolved;
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  fallbackModelRef?: string,
  options?: SessionModelResolutionOptions,
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
      agentId,
      manifestPlugins: options?.manifestPlugins,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, {
        allowPluginNormalization: options?.allowPluginNormalization,
        manifestPlugins: options?.manifestPlugins,
      });
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, {
      allowPluginNormalization: options?.allowPluginNormalization,
      manifestPlugins: options?.manifestPlugins,
    });
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
      agentId,
      manifestPlugins: options?.manifestPlugins,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRefCore(cfg, entry, agentId, options);
  return { provider: resolved.provider, model: resolved.model };
}
