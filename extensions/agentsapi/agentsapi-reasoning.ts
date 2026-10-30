import type { AgentReasoningParam } from "openai/resources/beta/agents/agents";
import { selectSupportedReasoningEffort } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortMap,
  resolveOpenAIReasoningEffortMapping,
} from "openclaw/plugin-sdk/llm";

export function resolveAgentsApiReasoningEffort(
  params: Pick<AgentHarnessAttemptParamsV2, "model" | "thinkLevel">,
): AgentReasoningParam["effort"] {
  if (params.thinkLevel === "ultra") {
    throw new Error("Agents API MVP does not support the ultra delegation mode");
  }
  if (params.thinkLevel === "adaptive") {
    return undefined;
  }
  const supportedEfforts = resolveOpenAIModelReasoningEfforts(params.model);
  const modelMapped = params.model.thinkingLevelMap?.[params.thinkLevel];
  if (!params.model.reasoning || supportedEfforts?.length === 0 || modelMapped === null) {
    return undefined;
  }
  const mapped =
    resolveOpenAIReasoningEffortMapping(
      params.thinkLevel,
      resolveOpenAIReasoningEffortMap(params.model),
    ) ?? modelMapped;
  const effort = mapped?.trim() ?? (params.thinkLevel === "off" ? "none" : params.thinkLevel);
  switch (effort) {
    case "none":
      return supportedEfforts?.includes("none") ? effort : undefined;
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return supportedEfforts === undefined
        ? effort
        : selectSupportedReasoningEffort({
            requested: effort,
            supportedEfforts,
            effortOrder: ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
          });
    default:
      throw new Error(`Agents API does not support reasoning effort ${effort}`);
  }
}
