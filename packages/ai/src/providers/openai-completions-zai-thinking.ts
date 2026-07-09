import type { ModelThinkingLevel } from "../types.js";

type ZaiCompletionsThinkingModel = {
  id: string;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
};
type ZaiCompletionsRequestedEffort = ModelThinkingLevel | "none";

function isZaiOpenAICompletionsReasoningEffortSupported(
  model: ZaiCompletionsThinkingModel,
): boolean {
  return model.id.toLowerCase().startsWith("glm-5.2") || model.thinkingLevelMap !== undefined;
}

export function resolveZaiOpenAICompletionsThinkingParams(params: {
  model: ZaiCompletionsThinkingModel;
  requestedEffort: ZaiCompletionsRequestedEffort | undefined;
}): { thinking: { type: "enabled" | "disabled" }; reasoningEffort?: string } {
  const effort = params.requestedEffort;
  if (!effort || effort === "off" || effort === "none") {
    return { thinking: { type: "disabled" } };
  }
  const enabledEffort = effort === "minimal" ? "low" : effort;
  const mapped = params.model.thinkingLevelMap?.[enabledEffort];
  const reasoningEffort =
    mapped ?? (enabledEffort === "xhigh" || enabledEffort === "max" ? "max" : "high");
  return {
    thinking: { type: "enabled" },
    ...(isZaiOpenAICompletionsReasoningEffortSupported(params.model) ? { reasoningEffort } : {}),
  };
}
