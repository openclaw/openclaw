// Resolves persisted session model metadata without loading Gateway projections.
import {
  hasSessionActiveAutoModelFallback,
  resolveSessionModelOverrideRouteResolution,
} from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveNativeModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
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
      | "modelOverrideSource"
      | "providerOverride"
      | "modelOverrideRouteResolution"
      | "modelOverrideFallbackOriginProvider"
      | "modelOverrideFallbackOriginModel"
    >;

/** Preserve a known submitted selection without mistaking automatic failover for a user edit. */
export function resolveSessionSubmittedModelRef(
  entry: SessionEntry | undefined,
): { provider: string; model: string } | undefined {
  if (entry?.lastSubmittedModel) {
    return entry.lastSubmittedModel;
  }
  const fallbackSelected = entry?.fallbackNotice?.selectedModel
    ? parseModelRef(
        entry.fallbackNotice.selectedModel,
        entry.modelProvider ?? entry.providerOverride ?? DEFAULT_PROVIDER,
        { allowPluginNormalization: false },
      )
    : undefined;
  if (fallbackSelected) {
    return fallbackSelected;
  }
  const originProvider = entry?.modelOverrideFallbackOriginProvider;
  const originModel = entry?.modelOverrideFallbackOriginModel;
  if (originProvider && originModel && hasSessionActiveAutoModelFallback(entry)) {
    return { provider: originProvider, model: originModel };
  }
  return entry?.modelProvider && entry.model
    ? { provider: entry.modelProvider, model: entry.model }
    : undefined;
}

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
  // Default snapshots are historical context, not a pin on the next turn.
  if (entry?.modelOverrideSource === "default") {
    return resolveSessionConfiguredDefault(cfg, agentId, options);
  }
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
  if (runtimeModel && runtimeProvider) {
    return { provider: runtimeProvider, model: runtimeModel };
  }
  const model = runtimeModel || fallbackModelRef?.trim();
  if (model) {
    const inferConfigured = () => {
      const provider = inferUniqueProviderFromConfiguredModels({
        cfg,
        model,
        agentId,
        manifestPlugins: options?.manifestPlugins,
      });
      return provider ? { provider, model } : undefined;
    };
    const parseSelected = () => {
      const parsed = parseModelRef(model, DEFAULT_PROVIDER, {
        allowPluginNormalization: options?.allowPluginNormalization,
        manifestPlugins: options?.manifestPlugins,
      });
      return parsed ? { provider: parsed.provider, model: parsed.model } : undefined;
    };
    return (
      (runtimeModel
        ? (inferConfigured() ?? (model.includes("/") ? parseSelected() : undefined))
        : (parseSelected() ?? inferConfigured())) ?? { model }
    );
  }
  const resolved = resolveSessionModelRefCore(cfg, entry, agentId, options);
  return { provider: resolved.provider, model: resolved.model };
}

/**
 * Resolves the auth profile a session-scoped utility call should use: the
 * session-sticky linked account selection first, else the configured primary's
 * profile when it serves the same provider. Explicitly configured model routes
 * keep their own profile; callers derive their effective session route from this.
 */
export function resolveSessionAuthProfile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: Pick<SessionEntry, "authProfileOverride">;
  provider: string;
}): string | undefined {
  const sessionProfile = params.entry?.authProfileOverride?.trim();
  if (sessionProfile) {
    return sessionProfile;
  }
  const configuredRef = resolveNativeModelPrimary(params.cfg, params.agentId)?.trim();
  const configuredProfile = configuredRef
    ? splitTrailingAuthProfile(configuredRef).profile
    : undefined;
  if (!configuredProfile) {
    return undefined;
  }
  const configuredModel = resolveSessionModelRefCore(params.cfg, undefined, params.agentId);
  return configuredModel.provider === params.provider ? configuredProfile : undefined;
}
