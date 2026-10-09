import type { Model, SimpleStreamOptions } from "@openclaw/llm-core";
import type { AnthropicOptions } from "../provider-options.js";
import {
  defaultsClaudeAdaptiveThinking,
  requiresClaudeAdaptiveThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeHaiku55ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
} from "../providers/anthropic-model-contract.js";
import { adjustMaxTokensForThinking } from "../providers/simple-options.js";
import { copyProviderAcceptanceObserver } from "./transport-stream-shared.js";

const ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS = 4_096;
const ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR = 4;

export type AnthropicTransportOptions = AnthropicOptions &
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "stop"> & {
    authProfileId?: string;
  };

function resolvePositiveAnthropicTokenLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

export function resolveAnthropicMessagesMaxTokens(params: {
  modelContextWindow: number | undefined;
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
  useModelDefault?: boolean;
}): number | undefined {
  const requested = resolvePositiveAnthropicTokenLimit(params.requestedMaxTokens);
  if (requested !== undefined) {
    return requested;
  }
  const modelMax = resolvePositiveAnthropicTokenLimit(params.modelMaxTokens);
  if (modelMax !== undefined) {
    return params.useModelDefault ? modelMax : Math.min(modelMax, 32_000);
  }
  if (params.modelMaxTokens !== undefined) {
    return undefined;
  }
  // Anthropic requires max_tokens even when an optional custom-model row has no output cap.
  // Use a conservative compatibility baseline; higher model limits require explicit metadata.
  const contextWindow = resolvePositiveAnthropicTokenLimit(params.modelContextWindow);
  return contextWindow === undefined
    ? ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS
    : Math.max(
        1,
        Math.min(
          ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS,
          Math.floor(contextWindow / ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR),
        ),
      );
}

export function resolveAnthropicTransportOptions(
  model: Model<"anthropic-messages">,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
    modelContextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
    // Claude 5 defaults thinking on; the clamped 32k baseline starves thinking
    // plus response output, so these models keep their full catalog cap.
    useModelDefault:
      resolveClaudeHaiku55ModelIdentity(model) !== undefined ||
      resolveClaudeSonnet5ModelIdentity(model) !== undefined ||
      resolveClaudeOpus5ModelIdentity(model) !== undefined,
  });
  if (baseMaxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const resolved = copyProviderAcceptanceObserver(options, {
    temperature: options?.temperature,
    stop: options?.stop,
    maxTokens: baseMaxTokens,
    signal: options?.signal,
    apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    interleavedThinking: options?.interleavedThinking,
    toolChoice: options?.toolChoice,
    thinkingBudgets: options?.thinkingBudgets,
    thinkingDisplay: options?.thinkingDisplay,
    reasoning: options?.reasoning,
    anthropicServerCompaction: options?.anthropicServerCompaction,
    anthropicCompactThreshold: options?.anthropicCompactThreshold,
    cacheTtlPruning: options?.cacheTtlPruning,
    ...(options?.authProfileId ? { authProfileId: options.authProfileId } : {}),
  } satisfies AnthropicTransportOptions);
  resolved.reasoning = applyAnthropicThinkingOptions(model, resolved, options, "transport");
  return resolved;
}

/** Keep both entry points on one thinking mode while retaining their output-budget policies. */
export function applyAnthropicThinkingOptions(
  model: Model<"anthropic-messages">,
  resolved: AnthropicOptions & { maxTokens: number },
  options: Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets"> | undefined,
  profile: "provider" | "transport",
): SimpleStreamOptions["reasoning"] {
  const managed = profile === "transport";
  const reasoning =
    options?.reasoning === "off" && requiresClaudeAdaptiveThinking(model)
      ? "low"
      : options?.reasoning;
  if (reasoning === "off") {
    resolved.thinkingEnabled = false;
    return reasoning;
  }
  if (
    !reasoning ||
    supportsClaudeAdaptiveThinking(model) ||
    (!managed && defaultsClaudeAdaptiveThinking(model))
  ) {
    resolved.thinkingEnabled = Boolean(reasoning) || defaultsClaudeAdaptiveThinking(model);
    if (resolved.thinkingEnabled) {
      resolved.effort = resolveAnthropicThinkingEffort(model, reasoning);
    }
    return reasoning;
  }
  const adjusted = adjustMaxTokensForThinking(
    resolved.maxTokens,
    (managed ? resolvePositiveAnthropicTokenLimit(model.maxTokens) : model.maxTokens) ??
      resolved.maxTokens,
    managed && reasoning === "max" ? "high" : reasoning,
    options?.thinkingBudgets,
  );
  // Sub-minimum budgets (< 1024) resolve to thinking disabled so downstream
  // consumers (payload, replay, temperature, tool-choice) see consistent state.
  const thinkingEnabled = adjusted.thinkingBudget >= 1024;
  // The standalone provider restores the original output cap when thinking cannot fit.
  if (managed || thinkingEnabled) {
    resolved.maxTokens = adjusted.maxTokens;
  }
  resolved.thinkingEnabled = thinkingEnabled;
  resolved.thinkingBudgetTokens = thinkingEnabled ? adjusted.thinkingBudget : undefined;
  return reasoning;
}
