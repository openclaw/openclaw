import {
  resolveClaudeFable5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
} from "../../llm-core/src/index.js";
import type { ThinkingLevel } from "./types.js";

type EnabledThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;

const ENABLED_THINKING_LEVELS = new Set<EnabledThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isEnabledThinkingLevel(value: unknown): value is EnabledThinkingLevel {
  return ENABLED_THINKING_LEVELS.has(value as EnabledThinkingLevel);
}

export function resolveAgentReasoningOption(
  model: Model,
  thinkingLevel: ThinkingLevel,
): SimpleStreamOptions["reasoning"] {
  if (thinkingLevel !== "off") {
    return thinkingLevel;
  }
  const offFallback =
    model.thinkingLevelMap?.off ??
    ((model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model)
      ? "low"
      : undefined);
  return isEnabledThinkingLevel(offFallback) ? offFallback : undefined;
}
