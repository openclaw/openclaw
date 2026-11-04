/**
 * Builds model visibility policies while retaining configured automatic fallbacks.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  type ModelVisibilityPolicy,
} from "./model-selection-shared.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";

export const RUNTIME_MODEL_VISIBILITY_NORMALIZATION = {
  allowManifestNormalization: true,
  allowPluginNormalization: true,
} as const;

/** Model refs agent settings select; the per-model metadata map is not a visibility source. */
function resolveAdditionalConfiguredModelRefs(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  const defaults = params.cfg.agents?.defaults;
  const agent = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const utility = readUtilityModelSetting(params.cfg, params.agentId);
  return [
    resolveAgentModelPrimaryValue(defaults?.model),
    ...resolveAgentModelFallbackValues(defaults?.model),
    resolveAgentModelPrimaryValue(agent?.model),
    ...resolveAgentModelFallbackValues(agent?.model),
    ...(utility.kind === "explicit" ? [utility.modelRef] : []),
    ...(utility.kind !== "disabled" ? utility.fallbacks : []),
    resolveAgentModelPrimaryValue(defaults?.imageModel),
    ...resolveAgentModelFallbackValues(defaults?.imageModel),
    resolveAgentModelPrimaryValue(defaults?.pdfModel),
    ...resolveAgentModelFallbackValues(defaults?.pdfModel),
  ].filter((ref): ref is string => typeof ref === "string");
}

export function createModelVisibilityPolicy(
  params: Omit<
    Parameters<typeof createModelVisibilityPolicyWithFallbacks>[0],
    "fallbackModels" | "additionalConfiguredModelRefs"
  >,
): ModelVisibilityPolicy {
  return createModelVisibilityPolicyWithFallbacks({
    ...params,
    fallbackModels: resolveConfiguredModelFallbacks(params),
    additionalConfiguredModelRefs: resolveAdditionalConfiguredModelRefs(params),
    // Model visibility is used by lightweight status/list paths. Keep plugin
    // manifest normalization opt-in so those paths do not load plugin runtime
    // metadata unless a caller explicitly needs it.
    allowManifestNormalization: params.allowManifestNormalization ?? false,
    allowPluginNormalization: params.allowPluginNormalization ?? false,
  });
}

export type { ModelVisibilityPolicy };
