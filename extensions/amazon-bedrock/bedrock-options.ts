/**
 * Stream option extensions and prompt-cache policy for Amazon Bedrock models.
 * Provider registration and runtime streaming share these contracts.
 */
import type { StreamOptions, ThinkingBudgets, ThinkingLevel } from "openclaw/plugin-sdk/llm";

/** How Bedrock thinking output should be displayed to users. */
export type BedrockThinkingDisplay = "summarized" | "omitted";

/** Extra Bedrock-specific stream options accepted by the provider runtime. */
export interface BedrockOptions extends StreamOptions {
  region?: string;
  profile?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  interleavedThinking?: boolean;
  thinkingDisplay?: BedrockThinkingDisplay;
  requestMetadata?: Record<string, string>;
  bearerToken?: string;
}

function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

/** Return whether a Bedrock model is known to support Anthropic prompt caching. */
export function supportsBedrockPromptCaching(modelId: string, modelName?: string): boolean {
  const candidates = getModelMatchCandidates(modelId, modelName);
  const hasClaudeRef = candidates.some((s) => s.includes("claude"));
  if (!hasClaudeRef) {
    if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") {
      return true;
    }
    return false;
  }
  if (candidates.some((s) => s.includes("-4-"))) {
    return true;
  }
  // Claude 5 generation flagships (e.g. global.anthropic.claude-sonnet-5) support
  // Anthropic prompt caching on Bedrock, but their ids carry no "-4-" generation
  // marker, so match the family directly. The negative lookahead keeps a future
  // "claude-sonnet-50" from matching while allowing "-5", "-5-<minor>", "-5.0".
  if (candidates.some((s) => /claude-(?:sonnet|opus|haiku)-5(?![0-9])/.test(s))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-fable-5"))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-5-haiku"))) {
    return true;
  }
  return false;
}
