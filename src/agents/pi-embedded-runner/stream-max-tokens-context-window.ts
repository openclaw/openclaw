import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { log } from "./logger.js";

const STREAM_INPUT_CHARS_PER_TOKEN_ESTIMATE = 4;
const STREAM_INPUT_TOKEN_SAFETY_MARGIN = 1.2;
const MIN_CONTEXT_REMAINING_OUTPUT_TOKENS = 1;

type StreamContext = Parameters<StreamFn>[1];
type StreamModel = Parameters<StreamFn>[0];
type ContextWindowLikeModel = {
  contextTokens?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
};

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function estimateSerializableChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined || value === null) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

function estimateContentBlockChars(block: unknown): number {
  if (!block || typeof block !== "object") {
    return estimateSerializableChars(block);
  }
  const typed = block as {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  if (typed.type === "text" && typeof typed.text === "string") {
    return typed.text.length;
  }
  if (typed.type === "thinking" && typeof typed.thinking === "string") {
    return typed.thinking.length;
  }
  if (typed.type === "toolCall") {
    return (
      (typeof typed.name === "string" ? typed.name.length : 0) +
      estimateSerializableChars(typed.arguments)
    );
  }
  if (typed.type === "image") {
    return 8_000;
  }
  return estimateSerializableChars(block);
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return estimateSerializableChars(content);
  }
  return content.reduce((sum, block) => sum + estimateContentBlockChars(block), 0);
}

function estimateMessageChars(message: unknown): number {
  if (!message || typeof message !== "object") {
    return 0;
  }
  const record = message as { content?: unknown };
  const contentChars = estimateContentChars(record.content);
  return contentChars > 0 ? contentChars : estimateSerializableChars(message);
}

function estimateStreamInputTokens(context: StreamContext): number {
  const ctx = context as {
    messages?: unknown;
    systemPrompt?: unknown;
    tools?: unknown;
  };
  let chars = typeof ctx.systemPrompt === "string" ? ctx.systemPrompt.length : 0;
  if (Array.isArray(ctx.messages)) {
    chars += ctx.messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  }
  if (Array.isArray(ctx.tools) && ctx.tools.length > 0) {
    chars += estimateSerializableChars(ctx.tools);
  }
  return Math.max(
    0,
    Math.ceil((chars / STREAM_INPUT_CHARS_PER_TOKEN_ESTIMATE) * STREAM_INPUT_TOKEN_SAFETY_MARGIN),
  );
}

function resolveContextWindowTokens(
  callModel: StreamModel,
  configuredModel?: ProviderRuntimeModel,
): number | undefined {
  const callModelRecord = callModel as ContextWindowLikeModel;
  return (
    normalizePositiveInt(callModelRecord.contextTokens) ??
    normalizePositiveInt(configuredModel?.contextTokens) ??
    normalizePositiveInt(callModelRecord.contextWindow) ??
    normalizePositiveInt(configuredModel?.contextWindow)
  );
}

function resolveModelMaxTokens(
  callModel: StreamModel,
  configuredModel?: ProviderRuntimeModel,
): number | undefined {
  const callModelRecord = callModel as ContextWindowLikeModel;
  return (
    normalizePositiveInt(callModelRecord.maxTokens) ??
    normalizePositiveInt(configuredModel?.maxTokens)
  );
}

export function clampMaxTokensToContextWindow(params: {
  maxTokens: number | undefined;
  callModel: StreamModel;
  configuredModel?: ProviderRuntimeModel;
  context: StreamContext;
}): number | undefined {
  if (params.maxTokens === undefined || params.maxTokens <= 0) {
    return params.maxTokens;
  }
  const contextWindowTokens = resolveContextWindowTokens(params.callModel, params.configuredModel);
  if (contextWindowTokens === undefined) {
    return params.maxTokens;
  }
  const inputTokens = estimateStreamInputTokens(params.context);
  const remainingTokens = contextWindowTokens - inputTokens;
  if (remainingTokens >= params.maxTokens) {
    return params.maxTokens;
  }
  const clamped = Math.max(MIN_CONTEXT_REMAINING_OUTPUT_TOKENS, remainingTokens);
  log.debug(
    `clamping maxTokens to remaining context window: requested=${params.maxTokens} ` +
      `clamped=${clamped} inputTokens=${inputTokens} contextWindow=${contextWindowTokens}`,
  );
  return clamped;
}

export function clampModelMaxTokensToContextWindow(params: {
  callModel: StreamModel;
  configuredModel?: ProviderRuntimeModel;
  context: StreamContext;
}): number | undefined {
  return clampMaxTokensToContextWindow({
    maxTokens: resolveModelMaxTokens(params.callModel, params.configuredModel),
    callModel: params.callModel,
    configuredModel: params.configuredModel,
    context: params.context,
  });
}
