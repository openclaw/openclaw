import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  "gs",
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

const PLAMO_PAYLOAD_DUMP_PATH = process.env.OPENCLAW_PLAMO_PAYLOAD_DUMP_PATH?.trim() || "";

type OpenAIStyleToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  } | null;
};

type OpenAIStyleChunkDelta = {
  content?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_text?: unknown;
  tool_calls?: unknown;
  reasoning_details?: unknown;
};

type OpenAIStyleChunkChoice = {
  finish_reason?: unknown;
  delta?: OpenAIStyleChunkDelta | null;
  usage?: OpenAIStyleUsage | null;
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

type OpenAIStyleChunk = {
  id?: unknown;
  usage?: OpenAIStyleUsage | null;
  choices?: OpenAIStyleChunkChoice[] | null;
};

const DEFAULT_PLAMO_COMPAT: ResolvedPlamoCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  reasoningEffortMap: {},
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: false,
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

function dumpPlamoPayload(kind: "streaming", payload: Record<string, unknown>): void {
  if (!PLAMO_PAYLOAD_DUMP_PATH) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(PLAMO_PAYLOAD_DUMP_PATH), { recursive: true });
  } catch {
    // ignore dump directory failures
  }
  try {
    fs.appendFileSync(
      PLAMO_PAYLOAD_DUMP_PATH,
      `${JSON.stringify({ ts: Date.now(), kind, payload })}\n`,
      "utf8",
    );
  } catch {
    // ignore dump write failures
  }
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

function buildPlamoStreamingPayload(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): Record<string, unknown> {
  const compat = resolvePlamoCompat(model);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model as never, context as never, compat),
    stream: true,
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

function normalizePlamoStreamingPayload(
  payload: Record<string, unknown>,
  model: RuntimeModel,
): Record<string, unknown> {
  const compat = resolvePlamoCompat(model);
  payload.stream = true;
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

function finalizePlamoStreamingPayload(
  payload: Record<string, unknown>,
  model: RuntimeModel,
): Record<string, unknown> {
  return normalizePlamoStreamingPayload(payload, model);
}

async function resolvePlamoStreamingPayload(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): Promise<Record<string, unknown>> {
  let payload = finalizePlamoStreamingPayload(
    buildPlamoStreamingPayload(model, context, options),
    model,
  );
  const nextPayload = await options?.onPayload?.(payload, model);
  if (nextPayload !== undefined) {
    if (!nextPayload || typeof nextPayload !== "object" || Array.isArray(nextPayload)) {
      throw new Error("PLaMo payload override must return an object");
    }
    payload = nextPayload as Record<string, unknown>;
  }
  return finalizePlamoStreamingPayload(payload, model);
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
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    ...((model as { headers?: Record<string, string> }).headers ?? {}),
    ...(options?.headers ?? {}),
  };
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

type StreamingToolCallBlock = ToolCall & {
  partialArgs: string;
};

function parseSsePayloads(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  return {
    async *[Symbol.asyncIterator]() {
      let buffer = "";
      let currentData = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd !== -1) {
          let line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 1);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          if (line === "") {
            if (currentData) {
              yield currentData;
              currentData = "";
            }
            lineEnd = buffer.indexOf("\n");
            continue;
          }
          if (line.startsWith(":")) {
            lineEnd = buffer.indexOf("\n");
            continue;
          }
          const [rawField, ...rest] = line.split(":");
          const field = rawField.trim();
          const rawValue = rest.join(":");
          const data = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
          if (field === "data") {
            currentData = currentData ? `${currentData}\n${data}` : data;
          }
          lineEnd = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const lines = buffer.split(/\n/);
        for (let line of lines) {
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          if (!line || line.startsWith(":")) {
            continue;
          }
          const [rawField, ...rest] = line.split(":");
          const field = rawField.trim();
          const rawValue = rest.join(":");
          const data = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
          if (field === "data") {
            currentData = currentData ? `${currentData}\n${data}` : data;
          }
        }
      }
      if (currentData) {
        yield currentData;
      }
    },
  };
}

function parseStreamingChunk(raw: string): OpenAIStyleChunk | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(trimmed) as OpenAIStyleChunk;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid PLaMo stream chunk: ${message}`);
  }
}

function extractStreamingReasoning(delta: OpenAIStyleChunkDelta): string {
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
    const value = delta[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function createNativePlamoStream(
  model: RuntimeModel,
  context: RuntimeContext,
  options: RuntimeOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
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
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const payload = await resolvePlamoStreamingPayload(model, context, options);
      dumpPlamoPayload("streaming", payload);
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
      if (!response.body) {
        throw new Error("PLaMo streaming response did not include a body");
      }

      reader = response.body.getReader();
      stream.push({ type: "start", partial: output });

      let currentBlock:
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string; thinkingSignature?: string }
        | StreamingToolCallBlock
        | null = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      const finishCurrentBlock = () => {
        if (!currentBlock) {
          return;
        }
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        } else if (currentBlock.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output,
          });
        } else {
          const finalArgs = parseToolArguments(currentBlock.partialArgs) ?? {};
          delete (currentBlock as { partialArgs?: string }).partialArgs;
          currentBlock.arguments = finalArgs;
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall: currentBlock,
            partial: output,
          });
        }
        currentBlock = null;
      };

      for await (const rawChunk of parseSsePayloads(reader)) {
        const chunk = parseStreamingChunk(rawChunk);
        if (!chunk) {
          continue;
        }

        if (typeof chunk.id === "string" && chunk.id.length > 0) {
          output.responseId ||= chunk.id;
        }
        if (chunk.usage) {
          output.usage = parseUsage(chunk.usage, model);
        }

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) {
          continue;
        }
        if (!chunk.usage && choice.usage) {
          output.usage = parseUsage(choice.usage, model);
        }
        if (choice.finish_reason) {
          const finishReasonResult = mapStopReason(choice.finish_reason);
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
        }

        const delta =
          choice.delta && typeof choice.delta === "object"
            ? (choice.delta as OpenAIStyleChunkDelta)
            : null;
        if (!delta) {
          continue;
        }

        const textDelta = typeof delta.content === "string" ? delta.content : "";
        if (textDelta) {
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock();
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output,
          });
        }

        const reasoningDelta = extractStreamingReasoning(delta);
        if (reasoningDelta) {
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock();
            currentBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "reasoning_content",
            };
            output.content.push(currentBlock);
            stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.thinking += reasoningDelta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: reasoningDelta,
            partial: output,
          });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls as OpenAIStyleToolCall[]) {
            const nextId = typeof toolCall.id === "string" ? toolCall.id : "";
            if (
              !currentBlock ||
              currentBlock.type !== "toolCall" ||
              (nextId && currentBlock.id !== nextId)
            ) {
              finishCurrentBlock();
              currentBlock = {
                type: "toolCall",
                id: nextId,
                name:
                  toolCall.function && typeof toolCall.function === "object"
                    ? typeof toolCall.function.name === "string"
                      ? toolCall.function.name
                      : ""
                    : "",
                arguments: {},
                partialArgs: "",
              };
              output.content.push(currentBlock);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
            }
            if (currentBlock.type !== "toolCall") {
              continue;
            }
            if (nextId) {
              currentBlock.id = nextId;
            }
            if (toolCall.function && typeof toolCall.function === "object") {
              if (typeof toolCall.function.name === "string") {
                currentBlock.name = toolCall.function.name;
              }
              const argsDelta =
                typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "";
              if (argsDelta) {
                currentBlock.partialArgs += argsDelta;
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex(),
                  delta: argsDelta,
                  partial: output,
                });
              }
            }
          }
        }

        if (Array.isArray(delta.reasoning_details)) {
          for (const detail of delta.reasoning_details as Array<Record<string, unknown>>) {
            if (
              detail?.type === "reasoning.encrypted" &&
              typeof detail.id === "string" &&
              detail.data !== undefined
            ) {
              const matchingToolCall = output.content.find(
                (block) => block.type === "toolCall" && block.id === detail.id,
              );
              if (matchingToolCall && matchingToolCall.type === "toolCall") {
                matchingToolCall.thoughtSignature = JSON.stringify(detail);
              }
            }
          }
        }
      }

      finishCurrentBlock();
      normalizePlamoToolMarkupInMessage(output);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
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
    } finally {
      try {
        await reader?.cancel();
      } catch {
        // ignore reader cleanup failures
      }
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

  const wrapperBlocks = [...text.matchAll(PLAMO_TOOL_REQUESTS_BLOCK_RE)].map(
    (match) => match[1] ?? "",
  );
  const searchTexts = wrapperBlocks.length > 0 ? wrapperBlocks : [text];
  const toolCalls: ParsedPlamoToolCall[] = [];

  for (const searchText of searchTexts) {
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

function syncDoneEventReasonWithMessageStopReason(event: unknown): void {
  if (!event || typeof event !== "object") {
    return;
  }
  const doneEvent = event as {
    type?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  if (doneEvent.type !== "done" || !doneEvent.message || typeof doneEvent.message !== "object") {
    return;
  }
  const stopReason = (doneEvent.message as { stopReason?: unknown }).stopReason;
  if (typeof stopReason === "string" && stopReason.length > 0) {
    doneEvent.reason = stopReason;
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
            syncDoneEventReasonWithMessageStopReason(event);
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

export function createPlamoToolCallWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const sanitizedContext = sanitizePlamoReplayMessages(context);

    if (underlying === streamSimple) {
      return wrapStreamNormalizePlamoToolMarkup(
        createNativePlamoStream(model, sanitizedContext, options),
      );
    }

    const originalOnPayload = options?.onPayload;
    const maybeStream = underlying(model, sanitizedContext, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const effectiveModel = payloadModel ?? model;
        let nextPayload = payload;
        if (nextPayload && typeof nextPayload === "object" && !Array.isArray(nextPayload)) {
          nextPayload = finalizePlamoStreamingPayload(
            nextPayload as Record<string, unknown>,
            effectiveModel,
          );
        }
        const overridden = await originalOnPayload?.(nextPayload, effectiveModel);
        if (overridden !== undefined) {
          if (!overridden || typeof overridden !== "object" || Array.isArray(overridden)) {
            throw new Error("PLaMo payload override must return an object");
          }
          const normalized = finalizePlamoStreamingPayload(
            overridden as Record<string, unknown>,
            effectiveModel,
          );
          dumpPlamoPayload("streaming", normalized);
          return normalized;
        }
        if (nextPayload && typeof nextPayload === "object" && !Array.isArray(nextPayload)) {
          dumpPlamoPayload("streaming", nextPayload as Record<string, unknown>);
        }
        return nextPayload;
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
