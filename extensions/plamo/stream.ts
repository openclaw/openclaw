import { randomUUID } from "node:crypto";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getEnvApiKey,
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type OpenAICompletionsCompat,
  type StopReason,
  type Tool,
  type ToolCall,
  type Usage,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";

const PLAMO_BEGIN_TOOL_REQUEST = "<|plamo:begin_tool_request:plamo|>";
const PLAMO_END_TOOL_REQUEST = "<|plamo:end_tool_request:plamo|>";
const PLAMO_BEGIN_TOOL_REQUESTS = "<|plamo:begin_tool_requests:plamo|>";
const PLAMO_END_TOOL_REQUESTS = "<|plamo:end_tool_requests:plamo|>";
const PLAMO_BEGIN_TOOL_NAME = "<|plamo:begin_tool_name:plamo|>";
const PLAMO_END_TOOL_NAME = "<|plamo:end_tool_name:plamo|>";
const PLAMO_BEGIN_TOOL_ARGUMENTS = "<|plamo:begin_tool_arguments:plamo|>";
const PLAMO_END_TOOL_ARGUMENTS = "<|plamo:end_tool_arguments:plamo|>";
const PLAMO_MSG = "<|plamo:msg|>";

const PLAMO_TOOL_REQUEST_BLOCK_RE = new RegExp(
  `${escapeRegExp(PLAMO_BEGIN_TOOL_REQUEST)}(.*?)${escapeRegExp(PLAMO_END_TOOL_REQUEST)}`,
  "gs",
);
const PLAMO_TOOL_REQUESTS_BLOCK_RE = new RegExp(
  `${escapeRegExp(PLAMO_BEGIN_TOOL_REQUESTS)}(.*?)${escapeRegExp(PLAMO_END_TOOL_REQUESTS)}`,
  "s",
);

type ParsedPlamoToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type MessageContentBlock = {
  type?: unknown;
  text?: unknown;
};

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type RuntimeModel = Parameters<StreamFn>[0];
type RuntimeContext = Parameters<StreamFn>[1];
type RuntimeOptions = Parameters<StreamFn>[2];
type ResolvedPlamoCompat = Required<OpenAICompletionsCompat>;
type PlamoWrapperOptions = {
  useSyntheticStream?: boolean;
};

type OpenAIStyleToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  } | null;
};

type OpenAIStyleMessage = {
  content?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_text?: unknown;
  tool_calls?: unknown;
};

type OpenAIStyleChoice = {
  finish_reason?: unknown;
  message?: OpenAIStyleMessage | null;
};

type OpenAIStyleUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: {
    cached_tokens?: unknown;
  } | null;
  completion_tokens_details?: {
    reasoning_tokens?: unknown;
  } | null;
};

type OpenAIStyleCompletionResponse = {
  id?: unknown;
  model?: unknown;
  created?: unknown;
  usage?: OpenAIStyleUsage | null;
  choices?: OpenAIStyleChoice[] | null;
};

const DEFAULT_PLAMO_COMPAT: ResolvedPlamoCompat = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  reasoningEffortMap: {},
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

function isAssistantMessageWithContent(
  message: AgentMessage,
): message is Extract<AgentMessage, { role: "assistant" }> {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function dropPlamoThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (!isAssistantMessageWithContent(message)) {
      out.push(message);
      continue;
    }

    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of message.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }

    if (!changed) {
      out.push(message);
      continue;
    }

    out.push({
      ...message,
      content:
        nextContent.length > 0
          ? nextContent
          : ([{ type: "text", text: "" }] as AssistantContentBlock[]),
    });
  }
  return touched ? out : messages;
}

function sanitizePlamoReplayMessages(context: RuntimeContext): RuntimeContext {
  const messages = (context as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) {
    return context;
  }

  // PLaMo always emits `reasoning_content`, but replaying prior reasoning into
  // follow-up turns can cause the API to stop the visible answer mid-sentence.
  const sanitized = dropPlamoThinkingBlocks(messages as AgentMessage[]);
  if (sanitized === messages) {
    return context;
  }

  return {
    ...context,
    messages: sanitized,
  } as RuntimeContext;
}

function injectPlamoMaxTokens(
  payload: Record<string, unknown>,
  model: RuntimeModel,
  compat: ResolvedPlamoCompat,
): void {
  const field = compat.maxTokensField;
  const otherField = field === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  delete payload[otherField];
  if (Object.hasOwn(payload, field)) {
    return;
  }
  const maxTokens = (model as { maxTokens?: unknown }).maxTokens;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return;
  }
  payload[field] = Math.trunc(maxTokens);
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTaggedText(text: string, beginTag: string, endTag: string): string | null {
  const startIndex = text.indexOf(beginTag);
  if (startIndex === -1) {
    return null;
  }
  const contentStart = startIndex + beginTag.length;
  const endIndex = text.indexOf(endTag, contentStart);
  if (endIndex === -1) {
    return null;
  }
  return text.slice(contentStart, endIndex);
}

function extractToolArguments(block: string): string | null {
  const raw = extractTaggedText(block, PLAMO_BEGIN_TOOL_ARGUMENTS, PLAMO_END_TOOL_ARGUMENTS);
  if (raw === null) {
    return null;
  }
  const normalized = raw.includes(PLAMO_MSG) ? (raw.split(PLAMO_MSG, 2)[1] ?? "") : raw;
  return normalized.trim();
}

function parseToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isTextBlock(
  block: unknown,
): block is MessageContentBlock & { type: "text"; text: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function hasToolCallBlock(content: unknown[]): boolean {
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "toolUse" || type === "functionCall";
  });
}

function resolvePlamoCompat(model: RuntimeModel): ResolvedPlamoCompat {
  const compat = (model as { compat?: OpenAICompletionsCompat }).compat;
  return {
    ...DEFAULT_PLAMO_COMPAT,
    ...(compat ?? {}),
    reasoningEffortMap: compat?.reasoningEffortMap ?? DEFAULT_PLAMO_COMPAT.reasoningEffortMap,
    openRouterRouting: compat?.openRouterRouting ?? DEFAULT_PLAMO_COMPAT.openRouterRouting,
    vercelGatewayRouting: compat?.vercelGatewayRouting ?? DEFAULT_PLAMO_COMPAT.vercelGatewayRouting,
  };
}

function hasToolHistory(messages: AgentMessage[]): boolean {
  for (const message of messages) {
    if (message.role === "toolResult") {
      return true;
    }
    if (
      message.role === "assistant" &&
      message.content.some(
        (block) => block && typeof block === "object" && block.type === "toolCall",
      )
    ) {
      return true;
    }
  }
  return false;
}

function convertTools(tools: Tool[], compat: ResolvedPlamoCompat): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode !== false && { strict: false }),
    },
  }));
}

function buildPlamoPayload(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): Record<string, unknown> {
  const compat = resolvePlamoCompat(model);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model as never, context as never, compat),
    stream: false,
  };

  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    params[compat.maxTokensField] = options.maxTokens;
  } else {
    injectPlamoMaxTokens(params, model, compat);
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if ((options as { toolChoice?: unknown } | undefined)?.toolChoice) {
    params.tool_choice = (options as { toolChoice?: unknown }).toolChoice;
  }
  return params;
}

function normalizePlamoPayload(
  payload: Record<string, unknown>,
  model: RuntimeModel,
): Record<string, unknown> {
  const compat = resolvePlamoCompat(model);
  payload.stream = false;
  delete payload.stream_options;
  if (!compat.supportsStore) {
    delete payload.store;
  }
  if (!compat.supportsReasoningEffort) {
    delete payload.reasoning_effort;
  }
  injectPlamoMaxTokens(payload, model, compat);

  const tools = payload.tools;
  if (!compat.supportsStrictMode && Array.isArray(tools)) {
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") {
        continue;
      }
      const fn = (tool as { function?: unknown }).function;
      if (fn && typeof fn === "object") {
        delete (fn as { strict?: unknown }).strict;
      }
    }
  }
  return payload;
}

async function resolvePlamoPayload(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): Promise<Record<string, unknown>> {
  let payload = normalizePlamoPayload(buildPlamoPayload(model, context, options), model);
  const nextPayload = await options?.onPayload?.(payload, model);
  if (nextPayload !== undefined) {
    if (!nextPayload || typeof nextPayload !== "object" || Array.isArray(nextPayload)) {
      throw new Error("PLaMo payload override must return an object");
    }
    payload = nextPayload as Record<string, unknown>;
  }
  return normalizePlamoPayload(payload, model);
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", normalizedBaseUrl).toString();
}

function resolvePlamoApiKey(model: RuntimeModel, options: RuntimeOptions): string {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  return apiKey;
}

function buildRequestHeaders(
  model: RuntimeModel,
  apiKey: string,
  options: RuntimeOptions,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...((model as { headers?: Record<string, string> }).headers ?? {}),
    ...(options?.headers ?? {}),
  };
}

async function parseJsonResponse(response: Response): Promise<OpenAIStyleCompletionResponse> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as OpenAIStyleCompletionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PLaMo JSON response: ${message}`);
  }
}

function formatHttpErrorMessage(status: number, statusText: string, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return `PLaMo request failed: ${status} ${statusText}`;
  }
  return `PLaMo request failed: ${status} ${statusText}\n${trimmed}`;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildZeroUsage(model: RuntimeModel): Usage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function parseUsage(rawUsage: OpenAIStyleUsage | null | undefined, model: RuntimeModel): Usage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return buildZeroUsage(model);
  }
  const cachedTokens = toFiniteNumber(rawUsage.prompt_tokens_details?.cached_tokens);
  const reasoningTokens = toFiniteNumber(rawUsage.completion_tokens_details?.reasoning_tokens);
  const input = toFiniteNumber(rawUsage.prompt_tokens) - cachedTokens;
  const output = toFiniteNumber(rawUsage.completion_tokens) + reasoningTokens;
  const usage: Usage = {
    input,
    output,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: input + output + cachedTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function mapStopReason(reason: unknown): { stopReason: StopReason; errorMessage?: string } {
  if (reason === null || reason === undefined) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${String(reason)}`,
      };
  }
}

function normalizeReasoningText(message: OpenAIStyleMessage): string {
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
    const value = message[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function normalizeVisibleText(message: OpenAIStyleMessage): string {
  return typeof message.content === "string" ? stripPlamoToolMarkup(message.content) : "";
}

function normalizeUpstreamToolCall(toolCall: OpenAIStyleToolCall): ToolCall | null {
  const fn = toolCall.function;
  if (!fn || typeof fn !== "object") {
    return null;
  }
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (!name) {
    return null;
  }

  let args: Record<string, unknown> = {};
  if (typeof fn.arguments === "string") {
    args = parseToolArguments(fn.arguments) ?? {};
  } else if (fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)) {
    args = fn.arguments as Record<string, unknown>;
  }

  return {
    type: "toolCall",
    id:
      typeof toolCall.id === "string" && toolCall.id.length > 0
        ? toolCall.id
        : `plamo_call_${randomUUID().replaceAll("-", "")}`,
    name,
    arguments: args,
  };
}

function normalizeToolCalls(message: OpenAIStyleMessage): ToolCall[] {
  const upstreamToolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as OpenAIStyleToolCall[])
        .map(normalizeUpstreamToolCall)
        .filter((toolCall): toolCall is ToolCall => toolCall !== null)
    : [];
  if (upstreamToolCalls.length > 0) {
    return upstreamToolCalls;
  }

  const seen = new Set<string>();
  for (const field of ["content", "reasoning", "reasoning_content"] as const) {
    const value = message[field];
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const parsed = parsePlamoToolCalls(value);
    if (parsed.length === 0) {
      continue;
    }
    return parsed.map((toolCall) => ({
      type: "toolCall",
      id: `plamo_call_${randomUUID().replaceAll("-", "")}`,
      name: toolCall.name,
      arguments: toolCall.arguments,
    }));
  }
  return [];
}

function buildAssistantMessageFromCompletion(
  upstream: OpenAIStyleCompletionResponse,
  model: RuntimeModel,
): AssistantMessage {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model:
      typeof upstream.model === "string" && upstream.model.length > 0 ? upstream.model : model.id,
    ...(typeof upstream.id === "string" && upstream.id.length > 0
      ? { responseId: upstream.id }
      : {}),
    usage: parseUsage(upstream.usage, model),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const choice = Array.isArray(upstream.choices) ? upstream.choices[0] : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? choice.message
      : ({} as OpenAIStyleMessage);
  const reasoning = normalizeReasoningText(message);
  if (reasoning) {
    output.content.push({
      type: "thinking",
      thinking: reasoning,
      thinkingSignature: "reasoning_content",
    });
  }

  const text = normalizeVisibleText(message);
  if (text) {
    output.content.push({
      type: "text",
      text,
    });
  }

  const toolCalls = normalizeToolCalls(message);
  if (toolCalls.length > 0) {
    output.content.push(...toolCalls);
    output.stopReason = "toolUse";
    return output;
  }

  const stopReasonResult = mapStopReason(choice?.finish_reason);
  output.stopReason = stopReasonResult.stopReason;
  if (stopReasonResult.errorMessage) {
    output.errorMessage = stopReasonResult.errorMessage;
  }
  return output;
}

function emitMessageBlocks(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  blocks: AssistantMessage["content"],
): void {
  for (const block of blocks) {
    const contentIndex = partial.content.length;

    if (block.type === "thinking") {
      const nextBlock = {
        type: "thinking" as const,
        thinking: "",
        ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(block.redacted ? { redacted: true } : {}),
      };
      partial.content.push(nextBlock);
      stream.push({ type: "thinking_start", contentIndex, partial });
      nextBlock.thinking = block.thinking;
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial,
      });
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial,
      });
      continue;
    }

    if (block.type === "text") {
      const nextBlock = {
        type: "text" as const,
        text: "",
        ...(block.textSignature ? { textSignature: block.textSignature } : {}),
      };
      partial.content.push(nextBlock);
      stream.push({ type: "text_start", contentIndex, partial });
      nextBlock.text = block.text;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      });
      continue;
    }

    const nextBlock: ToolCall = {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: {},
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
    };
    partial.content.push(nextBlock);
    stream.push({ type: "toolcall_start", contentIndex, partial });
    const delta = JSON.stringify(block.arguments);
    nextBlock.arguments = block.arguments;
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta,
      partial,
    });
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: nextBlock,
      partial,
    });
  }
}

function buildErrorAssistantMessage(
  model: RuntimeModel,
  error: unknown,
  aborted: boolean,
): AssistantMessage & { stopReason: Extract<StopReason, "aborted" | "error"> } {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: buildZeroUsage(model),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function createSyntheticPlamoStream(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: buildZeroUsage(model),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  void (async () => {
    try {
      stream.push({ type: "start", partial });
      const payload = await resolvePlamoPayload(model, context, options);
      const apiKey = resolvePlamoApiKey(model, options);
      const response = await fetch(buildChatCompletionsUrl(model.baseUrl), {
        method: "POST",
        headers: buildRequestHeaders(model, apiKey, options),
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new Error(
          formatHttpErrorMessage(response.status, response.statusText, await response.text()),
        );
      }

      const upstream = await parseJsonResponse(response);
      const finalMessage = buildAssistantMessageFromCompletion(upstream, model);
      partial.responseId = finalMessage.responseId;
      partial.model = finalMessage.model;
      partial.usage = finalMessage.usage;
      partial.stopReason = finalMessage.stopReason;
      if (finalMessage.errorMessage) {
        partial.errorMessage = finalMessage.errorMessage;
      }

      emitMessageBlocks(stream, partial, finalMessage.content);

      const stopReason = finalMessage.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        stream.push({ type: "error", reason: stopReason, error: partial });
      } else {
        stream.push({
          type: "done",
          reason: stopReason,
          message: partial,
        });
      }
      stream.end();
    } catch (error) {
      const aborted =
        options?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      const errorMessage = buildErrorAssistantMessage(model, error, aborted);
      stream.push({
        type: "error",
        reason: errorMessage.stopReason,
        error: errorMessage,
      });
      stream.end();
    }
  })();

  return stream;
}

export function stripPlamoToolMarkup(text: string): string {
  return text
    .replace(PLAMO_TOOL_REQUESTS_BLOCK_RE, "")
    .replace(PLAMO_TOOL_REQUEST_BLOCK_RE, "")
    .trim();
}

export function parsePlamoToolCalls(text: string): ParsedPlamoToolCall[] {
  if (!text) {
    return [];
  }

  const toolRequestsMatch = PLAMO_TOOL_REQUESTS_BLOCK_RE.exec(text);
  const searchText = toolRequestsMatch?.[1] ?? text;
  const toolCalls: ParsedPlamoToolCall[] = [];

  for (const match of searchText.matchAll(PLAMO_TOOL_REQUEST_BLOCK_RE)) {
    const block = match[1] ?? "";
    const name = extractTaggedText(block, PLAMO_BEGIN_TOOL_NAME, PLAMO_END_TOOL_NAME)?.trim();
    const rawArguments = extractToolArguments(block);
    if (!name || rawArguments === null) {
      continue;
    }
    const argumentsObject = parseToolArguments(rawArguments);
    if (!argumentsObject) {
      continue;
    }
    toolCalls.push({
      name,
      arguments: argumentsObject,
    });
  }

  return toolCalls;
}

export function normalizePlamoToolMarkupInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  const textBlocks = content.filter(isTextBlock);
  if (textBlocks.length === 0) {
    return;
  }

  const combinedText = textBlocks.map((block) => block.text).join("");
  if (
    !combinedText.includes(PLAMO_BEGIN_TOOL_REQUEST) &&
    !combinedText.includes(PLAMO_BEGIN_TOOL_REQUESTS)
  ) {
    return;
  }

  const cleanedText = stripPlamoToolMarkup(combinedText);
  const synthesizedToolCalls = hasToolCallBlock(content) ? [] : parsePlamoToolCalls(combinedText);

  const nextContent: unknown[] = [];
  let injectedText = false;
  for (const block of content) {
    if (!isTextBlock(block)) {
      nextContent.push(block);
      continue;
    }
    if (injectedText) {
      continue;
    }
    injectedText = true;
    if (cleanedText) {
      nextContent.push({ ...block, text: cleanedText });
    }
  }

  for (const toolCall of synthesizedToolCalls) {
    nextContent.push({
      type: "toolCall",
      id: `plamo_call_${randomUUID().replaceAll("-", "")}`,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  (message as { content: unknown[] }).content = nextContent;
  if (synthesizedToolCalls.length > 0) {
    (message as { stopReason?: unknown }).stopReason = "toolUse";
  }
}

function wrapStreamNormalizePlamoToolMarkup(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    normalizePlamoToolMarkupInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            normalizePlamoToolMarkupInMessage(event.partial);
            normalizePlamoToolMarkupInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

export function createPlamoToolCallWrapper(
  baseStreamFn: StreamFn | undefined,
  wrapperOptions?: PlamoWrapperOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const useSyntheticStream = wrapperOptions?.useSyntheticStream !== false;
  return (model, context, options) => {
    const sanitizedContext = sanitizePlamoReplayMessages(context);
    if (useSyntheticStream) {
      return createSyntheticPlamoStream(model, sanitizedContext, options);
    }

    const originalOnPayload = options?.onPayload;
    const maybeStream = underlying(model, sanitizedContext, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          injectPlamoMaxTokens(
            payload as Record<string, unknown>,
            model,
            resolvePlamoCompat(model),
          );
        }
        return originalOnPayload?.(payload, model);
      },
    });
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamNormalizePlamoToolMarkup(stream),
      );
    }
    return wrapStreamNormalizePlamoToolMarkup(maybeStream);
  };
}
