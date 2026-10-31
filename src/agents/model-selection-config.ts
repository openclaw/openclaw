/** Pure configured-model selection helpers safe for config validation. */
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveAgentModelConfigForRuntime, resolveAgentConfig } from "./agent-scope-config.js";
import {
  resolveAgentModelFallbacksOverride,
  resolveSubagentSpawnModelFallbacksOverride,
} from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelFallbackAvailability } from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeModelSelection, resolveConfiguredModelRef } from "./model-selection-shared.js";

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  return resolveConfiguredModelRef({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
  modelRuntime?: "native" | "acp";
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false
      ? undefined
      : normalizeModelSelection(
          resolveAgentModelConfigForRuntime(agentConfig, params.modelRuntime),
        ))
  );
}

function modelFallbackAvailabilityFromModels(
  models: string[],
  source: "explicit" | "inherited",
): ModelFallbackAvailability {
  return models.length > 0
    ? { kind: "active", models, source }
    : { kind: "none_configured", source };
}

/**
 * Projects availability onto the candidate-resolver override contract. Inherited
 * availability must project to `undefined`: the resolver then owns the ladder — it
 * re-derives the same configured fallbacks and appends the configured primary as the
 * final candidate (see model-fallback-candidates.ts). Collapsing inherited state into
 * an explicit list silently drops that last hop.
 */
export function modelFallbackOverrideFromAvailability(
  availability: ModelFallbackAvailability,
): string[] | undefined {
  switch (availability.kind) {
    case "active":
      return availability.source === "inherited" ? undefined : availability.models;
    case "none_configured":
      return availability.source === "inherited" ? undefined : [];
    default:
      return [];
  }
}

/**
 * Resolves fallback availability once for the run scope. A different user-selected model
 * disables the configured ladder; selecting the configured primary keeps its fallbacks.
 */
export function resolveModelFallbackAvailability(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  selectedModel?: ModelRef;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
  modelSelectionLocked?: boolean;
  modelFallbacksOverride?: string[];
  /** Declared child lineage includes visible sessions with dashboard keys. */
  subagentSpawnLineage?: boolean;
}): ModelFallbackAvailability {
  if (params.modelSelectionLocked) {
    return { kind: "disabled_by_model_selection_lock" };
  }
  if (params.modelFallbacksOverride !== undefined) {
    return modelFallbackAvailabilityFromModels(params.modelFallbacksOverride, "explicit");
  }
  const canUseConfiguredFallbacks =
    params.modelOverrideSource === "auto" ||
    (params.modelOverrideSource === undefined && params.hasAutoFallbackProvenance === true);
  let hasSessionModelOverride = params.hasSessionModelOverride;
  if (hasSessionModelOverride && !canUseConfiguredFallbacks) {
    if (!params.selectedModel) {
      return { kind: "disabled_by_model_override" };
    }
    const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
    if (
      primary.provider !== params.selectedModel.provider ||
      primary.model !== params.selectedModel.model
    ) {
      return { kind: "disabled_by_model_override" };
    }
    // Older clients persisted the displayed default as a user override.
    hasSessionModelOverride = false;
  }
  const hiddenSubagent = isSubagentSessionKey(params.sessionKey);
  // Hidden children without an effective override retain their existing agent policy.
  const useSubagentFallbacks = hasSessionModelOverride
    ? hiddenSubagent || params.subagentSpawnLineage === true
    : !hiddenSubagent &&
      params.subagentSpawnLineage === true &&
      params.modelOverrideSource !== "user";
  const fallbacksOverride = useSubagentFallbacks
    ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, params.agentId)
    : resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  // Auto overrides consume an explicit list, preventing a configured-primary append.
  const source =
    fallbacksOverride !== undefined || hasSessionModelOverride ? "explicit" : "inherited";
  return modelFallbackAvailabilityFromModels(
    fallbacksOverride ?? resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model),
    source,
  );
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  selectedModel?: ModelRef;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
  subagentSpawnLineage?: boolean;
}): string[] | undefined {
  return modelFallbackOverrideFromAvailability(resolveModelFallbackAvailability(params));
}
