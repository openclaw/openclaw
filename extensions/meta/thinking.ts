import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { META_MODEL_CATALOG } from "./provider-catalog.js";

const META_REASONING_MODELS = new Map(
  META_MODEL_CATALOG.filter((model) => model.reasoning).map((model) => [
    model.id.toLowerCase(),
    model,
  ]),
);

const META_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const META_THINKING_PROFILE = {
  levels: META_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

const META_MAX_THINKING_PROFILE = {
  ...META_THINKING_PROFILE,
  levels: [...META_THINKING_PROFILE.levels, { id: "max" }],
} satisfies ProviderThinkingProfile;

export function resolveMetaThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  // Some control-plane callers have no runtime catalog. Fall back to the
  // process-stable manifest so those paths retain the same model policy.
  const catalogModel = META_REASONING_MODELS.get(context.modelId.toLowerCase());
  if (!(context.reasoning ?? catalogModel?.reasoning)) {
    return undefined;
  }
  const efforts =
    context.compat?.supportedReasoningEfforts ?? catalogModel?.compat.supportedReasoningEfforts;
  return context.thinkingLevelMap?.max !== null && efforts?.includes("max")
    ? META_MAX_THINKING_PROFILE
    : META_THINKING_PROFILE;
}
