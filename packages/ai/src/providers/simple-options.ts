// Simple provider option helpers normalize lightweight provider configuration.
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingBudgets,
  ThinkingLevel,
} from "../types.js";

const CONTEXT_OUTPUT_SAFETY_TOKENS = 1024;
const MIN_OUTPUT_TOKENS = 1;
const MIN_IMAGE_INPUT_TOKENS = 1200;
const MAX_IMAGE_INPUT_TOKENS = 8192;
const ENCODED_IMAGE_CHARS_PER_TOKEN = 256;
const UTF8_ENCODER = new TextEncoder();

type FirstEventStreamOptions = {
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
};

export function buildBaseOptions(
  model: Model,
  options?: SimpleStreamOptions,
  apiKey?: string,
  context?: Context,
): StreamOptions & FirstEventStreamOptions {
  const firstEventOptions = options as FirstEventStreamOptions | undefined;
  return {
    temperature: options?.temperature,
    maxTokens: context
      ? clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens)
      : options?.maxTokens,
    stop: options?.stop,
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    transport: options?.transport,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    promptCacheKey: options?.promptCacheKey,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    firstEventTimeoutMs: firstEventOptions?.firstEventTimeoutMs,
    onFirstEventTimeout: firstEventOptions?.onFirstEventTimeout,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

function textTokenUpperBound(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function serializedTokenUpperBound(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? textTokenUpperBound(serialized) : 0;
  } catch {
    return 0;
  }
}

function estimateImageInputTokens(data: string): number {
  const scaledEstimate = Math.ceil(data.length / ENCODED_IMAGE_CHARS_PER_TOKEN);
  return Math.min(MAX_IMAGE_INPUT_TOKENS, Math.max(MIN_IMAGE_INPUT_TOKENS, scaledEstimate));
}

/** Cheap conservative prompt estimate for guarding provider max-token validation. */
export function estimateContextInputTokens(context: Context): number {
  let textTokens = context.systemPrompt ? textTokenUpperBound(context.systemPrompt) : 0;
  let imageTokens = 0;

  for (const message of context.messages) {
    textTokens += 16;
    if (typeof message.content === "string") {
      textTokens += textTokenUpperBound(message.content);
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          textTokens += textTokenUpperBound(block.text);
        } else if (block.type === "image") {
          imageTokens += estimateImageInputTokens(block.data);
        } else if (block.type === "thinking") {
          textTokens += textTokenUpperBound(block.thinking);
        } else if (block.type === "toolCall") {
          textTokens +=
            textTokenUpperBound(block.id) +
            textTokenUpperBound(block.name) +
            serializedTokenUpperBound(block.arguments);
        }
      }
    }
    if (message.role === "toolResult") {
      textTokens +=
        textTokenUpperBound(message.toolCallId ?? "") + textTokenUpperBound(message.toolName ?? "");
    }
  }

  for (const tool of context.tools ?? []) {
    textTokens +=
      textTokenUpperBound(tool.name) +
      textTokenUpperBound(tool.description) +
      serializedTokenUpperBound(tool.parameters);
  }

  return textTokens + imageTokens;
}

export function clampMaxTokensToContext(
  model: Model,
  context: Context,
  requestedMaxTokens: number,
): number {
  const estimatedInputTokens = estimateContextInputTokens(context);
  const remainingOutputTokens =
    model.contextWindow - estimatedInputTokens - CONTEXT_OUTPUT_SAFETY_TOKENS;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(requestedMaxTokens, remainingOutputTokens));
}

export function clampThinkingBudgetToMaxTokens(maxTokens: number, thinkingBudget: number): number {
  return Math.min(thinkingBudget, Math.max(0, maxTokens - 1));
}

export function clampReasoning(effort: ThinkingLevel): Exclude<ThinkingLevel, "xhigh">;
export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined;
export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
  // Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: Required<ThinkingBudgets> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    max: 32768,
  };
  const budgets = { ...defaultBudgets, ...customBudgets };

  const minOutputTokens = 1024;
  const level = clampReasoning(reasoningLevel);
  let thinkingBudget = budgets[level];
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}
