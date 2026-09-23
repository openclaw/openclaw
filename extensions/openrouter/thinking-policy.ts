import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveEffortThinkingProfile } from "openclaw/plugin-sdk/provider-thinking-runtime";
import { isOpenRouterDeepSeekV4ModelId } from "./models.js";

const OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: (["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveOpenRouterThinkingProfile(
  modelId: string,
  context?: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  if (
    context?.compat?.supportsReasoningEffort === false ||
    context?.compat?.supportedReasoningEfforts?.length === 0
  ) {
    return {
      levels:
        context?.thinkingLevelMap?.off === null
          ? [{ id: "low", label: "always on" }]
          : [{ id: "off" }, { id: "low", label: "on" }],
    };
  }
  const profile = resolveEffortThinkingProfile(context?.compat?.supportedReasoningEfforts);
  if (profile) {
    // OpenRouter's mandatory flag is projected to off:null during catalog ingestion.
    const levels = profile.levels.filter(
      (level) => level.id !== "off" || context?.thinkingLevelMap?.off !== null,
    );
    return {
      levels,
      ...(levels.some((level) => level.id === profile.defaultLevel)
        ? { defaultLevel: profile.defaultLevel }
        : {}),
    };
  }
  return isOpenRouterDeepSeekV4ModelId(modelId)
    ? OPENROUTER_DEEPSEEK_V4_THINKING_PROFILE
    : undefined;
}
