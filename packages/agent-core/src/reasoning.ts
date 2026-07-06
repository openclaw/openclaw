import {
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeSonnet5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
} from "../../llm-core/src/index.js";
import type { ThinkingLevel, ThinkingLevelSource } from "./types.js";

type StreamReasoningLevel = NonNullable<SimpleStreamOptions["reasoning"]>;

const STREAM_REASONING_LEVELS = new Set<StreamReasoningLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isStreamReasoningLevel(value: unknown): value is StreamReasoningLevel {
  return STREAM_REASONING_LEVELS.has(value as StreamReasoningLevel);
}

export function resolveAgentReasoningOption(
  model: Model,
  thinkingLevel: ThinkingLevel,
  thinkingLevelSource: ThinkingLevelSource = "explicit",
): SimpleStreamOptions["reasoning"] {
  if (thinkingLevel !== "off") {
    return thinkingLevel;
  }
  const offFallback =
    model.thinkingLevelMap?.off ??
    ((model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    requiresClaudeMandatoryAdaptiveThinking(model)
      ? "low"
      : undefined);
  if (isStreamReasoningLevel(offFallback)) {
    return offFallback;
  }
  return model.api === "anthropic-messages" &&
    resolveClaudeSonnet5ModelIdentity(model) !== undefined
    ? thinkingLevelSource === "explicit"
      ? "off"
      : undefined
    : undefined;
}
