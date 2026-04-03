import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getEnvApiKey,
  parseStreamingJson,
  type Api,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { resolveOpenAICompletionsCompatDefaultsFromCapabilities } from "./openai-completions-compat.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

const SUPPORTED_TRANSPORT_APIS = new Set<Api>([
  "openai-responses",
  "openai-completions",
  "azure-openai-responses",
]);

const SIMPLE_TRANSPORT_API_ALIAS: Record<string, Api> = {
  "openai-responses": "openclaw-openai-responses-transport",
  "openai-completions": "openclaw-openai-completions-transport",
  "azure-openai-responses": "openclaw-azure-openai-responses-transport",
};

type BaseStreamOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown;
  headers?: Record<string, string>;
};

type OpenAIResponsesOptions = BaseStreamOptions & {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
};

type OpenAICompletionsOptions = BaseStreamOptions & {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

type OpenAIModeModel = Model<Api> & {
  compat?: Record<string, unknown>;
};

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};

export function sanitizeTransportPayloadText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function stringifyJsonLike(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function getServiceTierCostMultiplier(serviceTier: ResponseCreateParamsStreaming["service_tier"]) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: MutableAssistantOutput["usage"],
  serviceTier?: ResponseCreateParamsStreaming["service_tier"],
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function inferCopilotInitiator(messages: Context["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return messages.some((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    return false;
  });
}

function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function transformMessages(
  messages: Context["messages"],
  model: Model<Api>,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model<Api>,
    source: { provider: string; api: Api; model: string },
  ) => string,
): Context["messages"] {
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...msg, toolCallId: normalizedId }
        : msg;
    }
    if (msg.role !== "assistant") {
      return msg;
    }
    const isSameModel =
      msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content: typeof msg.content = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            content.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          content.push(block);
          continue;
        }
        if (!block.thinking.trim()) {
          continue;
        }
        content.push(isSameModel ? block : { type: "text", text: block.thinking });
        continue;
      }
      if (block.type === "text") {
        content.push(isSameModel ? block : { type: "text", text: block.text });
        continue;
      }
      if (block.type !== "toolCall") {
        content.push(block);
        continue;
      }
      let normalizedToolCall = block;
      if (!isSameModel && block.thoughtSignature) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(block.id, model, msg);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...msg, content };
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: Array<{ id: string; name: string }> = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const toolCall of pendingToolCalls) {
          if (!existingToolResultIds.has(toolCall.id)) {
            result.push({
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text", text: "No result provided" }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = msg.content.filter(
        (block): block is Extract<(typeof msg.content)[number], { type: "toolCall" }> =>
          block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls.map((block) => ({ id: block.id, name: block.name }));
        existingToolResultIds = new Set();
      }
      result.push(msg);
      continue;
    }
    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }
    if (pendingToolCalls.length > 0) {
      for (const toolCall of pendingToolCalls) {
        if (!existingToolResultIds.has(toolCall.id)) {
          result.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          });
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(msg);
  }
  return result;
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

function convertResponsesMessages(
  model: Model<Api>,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: { includeSystemPrompt?: boolean; supportsDeveloperRole?: boolean },
): ResponseInput {
  const messages: ResponseInput = [];
  const normalizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<Api>,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
      content: sanitizeTransportPayloadText(context.systemPrompt),
    });
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeTransportPayloadText(msg.content) }],
        });
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature));
          }
        } else if (block.type === "text") {
          let msgId = parseTextSignature(block.textSignature)?.id ?? `msg_${msgIndex}`;
          if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            id: msgId,
            phase: parseTextSignature(block.textSignature)?.phase,
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const itemId = isDifferentModel && itemIdRaw?.startsWith("fc_") ? undefined : itemIdRaw;
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = msg.content.some((item) => item.type === "image");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(textResult
                  ? [{ type: "input_text", text: sanitizeTransportPayloadText(textResult) }]
                  : []),
                ...msg.content
                  .filter((item) => item.type === "image")
                  .map((item) => ({
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                  })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeTransportPayloadText(textResult || "(see attached image)"),
      });
    }
    msgIndex += 1;
  }
  return messages;
}

function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  options?: { strict?: boolean | null },
): FunctionTool[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict,
  }));
}

async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model<Api>,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
  },
) {
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  const blockIndex = () => output.content.length - 1;
  for await (const rawEvent of openaiStream) {
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
          name: stringifyUnknown(item.name),
          arguments: {},
          partialJson: stringifyJsonLike(item.arguments),
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
        currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: stringifyJsonLike(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary.map((part) => String((part as { text?: string }).text ?? "")).join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.thinking),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        const content = Array.isArray(item.content) ? item.content : [];
        currentBlock.text = content
          .map((part) =>
            (part as { type?: string; text?: string; refusal?: string }).type === "output_text"
              ? String((part as { text?: string }).text ?? "")
              : String((part as { refusal?: string }).refusal ?? ""),
          )
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(
          stringifyUnknown(item.id),
          (item.phase as "commentary" | "final_answer" | undefined) ?? undefined,
        );
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.text),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}"))
            : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall: {
            type: "toolCall",
            id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
            name: stringifyUnknown(item.name),
            arguments: args,
          },
          partial: output,
        });
        currentBlock = null;
      }
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      const usage = response?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            service_tier?: ResponseCreateParamsStreaming["service_tier"];
            status?: string;
          }
        | undefined;
      if (usage) {
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (usage.input_tokens || 0) - cachedTokens,
          output: usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model as never, output.usage as never);
      if (options?.applyServiceTierPricing) {
        options.applyServiceTierPricing(
          output.usage,
          (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
            options.serviceTier,
        );
      }
      output.stopReason = mapResponsesStopReason(response?.status as string | undefined);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const response = event.response as
        | {
            error?: { code?: string; message?: string };
            incomplete_details?: { reason?: string };
          }
        | undefined;
      const msg = response?.error
        ? `${response.error.code || "unknown"}: ${response.error.message || "no message"}`
        : response?.incomplete_details?.reason
          ? `incomplete: ${response.incomplete_details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
}

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

function hasTransportOverrides(model: Model<Api>): boolean {
  const request = getModelProviderRequestTransport(model);
  return Boolean(request?.proxy || request?.tls);
}

export function isTransportAwareApiSupported(api: Api): boolean {
  return SUPPORTED_TRANSPORT_APIS.has(api);
}

export function resolveTransportAwareSimpleApi(api: Api): Api | undefined {
  return SIMPLE_TRANSPORT_API_ALIAS[api];
}

export function createTransportAwareStreamFnForModel(model: Model<Api>): StreamFn | undefined {
  if (!hasTransportOverrides(model)) {
    return undefined;
  }
  if (!isTransportAwareApiSupported(model.api)) {
    throw new Error(
      `Model-provider request.proxy/request.tls is not yet supported for api "${model.api}"`,
    );
  }
  switch (model.api) {
    case "openai-responses":
      return createOpenAIResponsesTransportStreamFn();
    case "openai-completions":
      return createOpenAICompletionsTransportStreamFn();
    case "azure-openai-responses":
      return createAzureOpenAIResponsesTransportStreamFn();
    default:
      return undefined;
  }
}

function resolveModelRequestPolicy(model: Model<Api>) {
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    request: getModelProviderRequestTransport(model),
  });
}

function buildManagedResponse(response: Response, release: () => Promise<void>): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function buildGuardedModelFetch(model: Model<Api>): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const result = await fetchWithSsrFGuard({
      url,
      init: requestInit ?? init,
      dispatcherPolicy,
      ...(requestConfig.allowPrivateNetwork ? { policy: { allowPrivateNetwork: true } } : {}),
    });
    return buildManagedResponse(result.response, result.release);
  };
}

function buildOpenAIClientHeaders(
  model: Model<Api>,
  context: Context,
  optionHeaders?: Record<string, string>,
): Record<string, string> {
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      headers,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages: hasCopilotVisionInput(context.messages),
      }),
    );
  }
  if (optionHeaders) {
    Object.assign(headers, optionHeaders);
  }
  return headers;
}

function createOpenAIResponsesClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAIResponsesClient(model, context, apiKey, options?.headers);
        let params = buildOpenAIResponsesParams(model, context, options as OpenAIResponsesOptions);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          serviceTier: (options as OpenAIResponsesOptions | undefined)?.serviceTier,
          applyServiceTierPricing,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function resolveCacheRetention(cacheRetention: string | undefined): "short" | "long" | "none" {
  if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

export function buildOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
) {
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const messages = convertResponsesMessages(
    model,
    context,
    new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]),
    { supportsDeveloperRole },
  );
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    store: false,
  };
  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      params.reasoning = {
        effort: options?.reasoningEffort || "medium",
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot") {
      params.reasoning = { effort: "none" };
    }
  }
  return params;
}

function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: "azure-openai-responses",
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createAzureOpenAIClient(model, context, apiKey, options?.headers);
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          options as OpenAIResponsesOptions | undefined,
          deploymentName,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model<Api>): string {
  const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  if (deploymentMap) {
    for (const entry of deploymentMap.split(",")) {
      const [modelId, deploymentName] = entry.split("=", 2).map((value) => value?.trim());
      if (modelId === model.id && deploymentName) {
        return deploymentName;
      }
    }
  }
  return model.id;
}

function createAzureOpenAIClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  return new AzureOpenAI({
    apiKey,
    apiVersion: resolveAzureOpenAIApiVersion(),
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders),
    baseURL: normalizeAzureBaseUrl(model.baseUrl),
    fetch: buildGuardedModelFetch(model),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
) {
  const params = buildOpenAIResponsesParams(model, context, options);
  params.model = deploymentName;
  delete params.store;
  return params;
}

function hasToolHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
  );
}

function createOpenAICompletionsClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.chat.completions.create(params as never, {
          signal: options?.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ type: "start", partial: output as never });
        await processOpenAICompletionsStream(responseStream, output, model, stream);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model<Api>,
  stream: { push(event: unknown): void },
) {
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        partialArgs: string;
      }
    | null = null;
  const blockIndex = () => output.content.length - 1;
  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "toolCall") {
      currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
      const completed = {
        ...currentBlock,
        arguments: parseStreamingJson(currentBlock.partialArgs),
      };
      output.content[blockIndex()] = completed;
    }
  };
  for await (const chunk of responseStream) {
    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    if (!choice.delta) {
      continue;
    }
    if (choice.delta.content) {
      if (!currentBlock || currentBlock.type !== "text") {
        finishCurrentBlock();
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      }
      currentBlock.text += choice.delta.content;
      stream.push({
        type: "text_delta",
        contentIndex: blockIndex(),
        delta: choice.delta.content,
        partial: output,
      });
      continue;
    }
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    const reasoningField = reasoningFields.find((field) => {
      const value = (choice.delta as Record<string, unknown>)[field];
      return typeof value === "string" && value.length > 0;
    });
    if (reasoningField) {
      if (!currentBlock || currentBlock.type !== "thinking") {
        finishCurrentBlock();
        currentBlock = { type: "thinking", thinking: "", thinkingSignature: reasoningField };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      }
      currentBlock.thinking += String((choice.delta as Record<string, unknown>)[reasoningField]);
      stream.push({
        type: "thinking_delta",
        contentIndex: blockIndex(),
        delta: String((choice.delta as Record<string, unknown>)[reasoningField]),
        partial: output,
      });
      continue;
    }
    if (choice.delta.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        if (
          !currentBlock ||
          currentBlock.type !== "toolCall" ||
          (toolCall.id && currentBlock.id !== toolCall.id)
        ) {
          finishCurrentBlock();
          currentBlock = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
          };
          output.content.push(currentBlock);
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
        }
        if (currentBlock.type !== "toolCall") {
          continue;
        }
        if (toolCall.id) {
          currentBlock.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          currentBlock.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          currentBlock.partialArgs += toolCall.function.arguments;
          currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: toolCall.function.arguments,
            partial: output,
          });
        }
      }
    }
  }
  finishCurrentBlock();
}

function detectCompat(model: OpenAIModeModel) {
  const provider = model.provider;
  const capabilities = resolveProviderRequestCapabilities({
    provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    modelId: model.id,
    compat:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStore?: boolean })
        : undefined,
  });
  const endpointClass = capabilities.endpointClass;
  const isDefaultRoute = endpointClass === "default";
  const compatDefaults = resolveOpenAICompletionsCompatDefaultsFromCapabilities({
    provider,
    ...capabilities,
  });
  const isMistral =
    capabilities.knownProviderFamily === "mistral" || endpointClass === "mistral-public";
  const isZai = endpointClass === "zai-native" || (isDefaultRoute && provider === "zai");
  const useMaxTokens =
    endpointClass === "chutes-native" || (isDefaultRoute && provider === "chutes") || isMistral;
  const isGrok = endpointClass === "xai-native" || (isDefaultRoute && provider === "xai");
  const isGroq = endpointClass === "groq-native" || (isDefaultRoute && provider === "groq");
  const reasoningEffortMap: Record<string, string> =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};
  return {
    supportsStore:
      endpointClass !== "cerebras-native" &&
      endpointClass !== "chutes-native" &&
      endpointClass !== "deepseek-native" &&
      !isMistral &&
      endpointClass !== "opencode-native" &&
      endpointClass !== "xai-native" &&
      !isZai &&
      !(
        isDefaultRoute &&
        (provider === "cerebras" ||
          provider === "chutes" ||
          provider === "deepseek" ||
          provider === "opencode" ||
          provider === "xai")
      ),
    supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
    supportsReasoningEffort: !isGrok && !isMistral && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: isZai
      ? "zai"
      : provider === "openrouter" ||
          capabilities.endpointClass === "openrouter" ||
          capabilities.attributionProvider === "openrouter"
        ? "openrouter"
        : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: compatDefaults.supportsStrictMode,
  };
}

function getCompat(model: OpenAIModeModel): {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Record<string, string>;
  supportsUsageInStreaming: boolean;
  maxTokensField: string;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  thinkingFormat: string;
  openRouterRouting: Record<string, unknown>;
  vercelGatewayRouting: Record<string, unknown>;
  supportsStrictMode: boolean;
} {
  const detected = detectCompat(model);
  const compat = model.compat ?? {};
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    supportsStore,
    supportsDeveloperRole:
      (compat.supportsDeveloperRole as boolean | undefined) ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    reasoningEffortMap:
      (compat.reasoningEffortMap as Record<string, string> | undefined) ??
      detected.reasoningEffortMap,
    supportsUsageInStreaming:
      (compat.supportsUsageInStreaming as boolean | undefined) ?? detected.supportsUsageInStreaming,
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    requiresToolResultName:
      (compat.requiresToolResultName as boolean | undefined) ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      (compat.requiresAssistantAfterToolResult as boolean | undefined) ??
      detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText:
      (compat.requiresThinkingAsText as boolean | undefined) ?? detected.requiresThinkingAsText,
    thinkingFormat: (compat.thinkingFormat as string | undefined) ?? detected.thinkingFormat,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
    supportsStrictMode:
      (compat.supportsStrictMode as boolean | undefined) ?? detected.supportsStrictMode,
  };
}

type OpenAIResponsesRequestParams = {
  model: string;
  input: ResponseInput;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  reasoning?:
    | { effort: "none" }
    | {
        effort: NonNullable<OpenAIResponsesOptions["reasoningEffort"]>;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
};

function mapReasoningEffort(effort: string, reasoningEffortMap: Record<string, string>): string {
  return reasoningEffortMap[effort] ?? effort;
}

function convertTools(tools: NonNullable<Context["tools"]>, compat: ReturnType<typeof getCompat>) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode ? { strict: false } : {}),
    },
  }));
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model as never, context, compat as never),
    stream: true,
  };
  if (compat.supportsUsageInStreaming) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  if (compat.thinkingFormat === "openrouter" && model.reasoning && options?.reasoningEffort) {
    params.reasoning = {
      effort: mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap),
    };
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
  }
  return params;
}

export function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
  model: Model<Api>,
) {
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: input + outputTokens + cachedTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function mapStopReason(reason: string | null) {
  if (reason === null) {
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
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

export function prepareTransportAwareSimpleModel<TApi extends Api>(model: Model<TApi>): Model<Api> {
  const streamFn = createTransportAwareStreamFnForModel(model as Model<Api>);
  const alias = resolveTransportAwareSimpleApi(model.api);
  if (!streamFn || !alias) {
    return model;
  }
  return {
    ...model,
    api: alias,
  };
}

export function buildTransportAwareSimpleStreamFn(model: Model<Api>): StreamFn | undefined {
  return createTransportAwareStreamFnForModel(model);
}
