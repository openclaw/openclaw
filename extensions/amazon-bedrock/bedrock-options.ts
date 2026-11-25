/**
 * Stream option extensions and prompt-cache policy for Amazon Bedrock models.
 * Provider registration and runtime streaming share these contracts.
 */
import type { CachePointBlock } from "@aws-sdk/client-bedrock-runtime";
import type {
  CacheRetention,
  Model,
  ModelThinkingLevel,
  StreamOptions,
  ThinkingBudgets,
} from "openclaw/plugin-sdk/llm";
import { resolveClaudeModelIdentity } from "openclaw/plugin-sdk/provider-model-shared";

export type BedrockPromptCachePolicy = "nova" | "claude" | "claude-short";

/** Nova requires explicit opt-in; other models retain the existing env/default policy. */
export function resolveBedrockCacheRetention(
  policy: BedrockPromptCachePolicy | undefined,
  cacheRetention?: CacheRetention,
): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (policy === "nova") {
    return "none";
  }
  if (typeof process !== "undefined" && process.env.OPENCLAW_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

export function resolveBedrockPromptCachePolicy(
  model: Pick<Model, "id" | "params"> & { name?: string },
): BedrockPromptCachePolicy | undefined {
  // AWS Nova model cards allow system/messages checkpoints with a five-minute TTL.
  // Only unwrap foundation models and system profiles; application profiles stay opaque.
  const modelId = model.id
    .trim()
    .toLowerCase()
    .replace(
      /^arn:aws(?:-cn|-us-gov)?:bedrock:[^:]+:[^:]*:(?:foundation-model|inference-profile)\//,
      "",
    )
    .replace(/^(?:us|eu|apac|jp|global)\./, "");
  if (/^amazon\.nova-(?:micro|lite|pro|premier|2-lite)-v1:0$/.test(modelId)) {
    return "nova";
  }
  return resolveBedrockClaudeCachePolicy(resolveClaudeModelIdentity(model), model.name);
}

export function resolveBedrockCachePoint(
  policy: BedrockPromptCachePolicy | undefined,
  retention: CacheRetention,
): CachePointBlock | undefined {
  if (!policy || retention === "none") {
    return undefined;
  }
  return {
    type: "default",
    ...(policy === "claude" && retention === "long" ? { ttl: "1h" } : {}),
  };
}

type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
  region?: string;
  profile?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  reasoning?: ModelThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  interleavedThinking?: boolean;
  thinkingDisplay?: BedrockThinkingDisplay;
  requestMetadata?: Record<string, string>;
  bearerToken?: string;
}

function resolveBedrockClaudeCachePolicy(
  modelId: string,
  modelName?: string,
): "claude" | "claude-short" | undefined {
  const candidates = [modelId, modelName].map((id) => resolveClaudeModelIdentity({ id }));
  const hasClaudeRef = candidates.some((s) => s.includes("claude"));
  if (!hasClaudeRef) {
    return typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1"
      ? "claude-short"
      : undefined;
  }
  if (
    candidates.some((candidate) =>
      /^claude-(?:haiku-(?:4-5|5-5)|sonnet-(?:4-[56]|5(?:-5)?)|opus-(?:4-[5-8]|5(?:-5)?)|(?:fable|mythos)-5(?:-1)?)(?:$|-v\d|-\d{8}(?:-|$))/.test(
        candidate,
      ),
    )
  ) {
    return "claude";
  }
  return candidates.some(
    (candidate) =>
      candidate.includes("-4-") ||
      /^claude-(?:fable-5|mythos-5|opus-5|sonnet-5|haiku-5|3-7-sonnet|3-5-haiku)/.test(candidate),
  )
    ? "claude-short"
    : undefined;
}
