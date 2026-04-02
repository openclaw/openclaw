import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "codex-lb"]);

type CodexProxyStreamOptions = SimpleStreamOptions & {
  apiKey?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  transport?: "auto" | "sse" | "websocket";
  textVerbosity?: "low" | "medium" | "high";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  onPayload?: (
    payload: Record<string, unknown>,
    model: Model<Api>,
  ) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
};

type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress";

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;
type WebSocketLike = {
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  addEventListener: (type: WebSocketEventType, listener: WebSocketListener) => void;
  removeEventListener: (type: WebSocketEventType, listener: WebSocketListener) => void;
};

type OpenAIResponsesOutput = AssistantMessage & {
  usage: Usage;
  errorMessage?: string;
  responseId?: string;
};

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
  if (!partialJson?.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(partialJson) as T;
  } catch {
    return {} as T;
  }
}

function isDirectCodexBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "chatgpt.com";
  } catch {
    return baseUrl.toLowerCase().includes("chatgpt.com");
  }
}

export function shouldUseProxyCodexTransport(model: { api?: unknown; baseUrl?: unknown }): boolean {
  return model.api === "openai-codex-responses" && !isDirectCodexBaseUrl(model.baseUrl);
}

function sanitizeProviderForAccountId(provider: unknown): string {
  const value = typeof provider === "string" ? provider.trim().toLowerCase() : "proxy";
  const normalized = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "proxy";
}

export function resolveSyntheticCodexAccountId(params: {
  model: { provider?: unknown; headers?: Record<string, string> | undefined };
  headers?: Record<string, string> | undefined;
}): string {
  const explicit =
    params.headers?.["chatgpt-account-id"] ?? params.model.headers?.["chatgpt-account-id"];
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return `proxy_${sanitizeProviderForAccountId(params.model.provider)}`;
}

function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();

  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }

    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    if (msg.role === "assistant") {
      const assistantMsg = msg;
      const isSameModel =
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;

      const transformedContent = assistantMsg.content.flatMap((block) => {
        if (block.type === "thinking") {
          if (block.redacted) {
            return isSameModel ? block : [];
          }
          if (isSameModel && block.thinkingSignature) {
            return block;
          }
          if (!block.thinking || block.thinking.trim() === "") {
            return [];
          }
          if (isSameModel) {
            return block;
          }
          return { type: "text" as const, text: block.thinking };
        }

        if (block.type === "text") {
          if (isSameModel) {
            return block;
          }
          return { type: "text" as const, text: block.text };
        }

        if (block.type === "toolCall") {
          const toolCall = block;
          let normalizedToolCall: ToolCall = toolCall;

          if (!isSameModel && toolCall.thoughtSignature) {
            normalizedToolCall = { ...toolCall };
            delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
          }

          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
            }
          }

          return normalizedToolCall;
        }

        return block;
      });

      return {
        ...assistantMsg,
        content: transformedContent,
      };
    }

    return msg;
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (!existingToolResultIds.has(tc.id)) {
            result.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: "No result provided" }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }

      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }

      const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
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

    if (msg.role === "user" && pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
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

function convertResponsesMessages(
  model: Model<Api>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
): ResponseInput {
  const messages: ResponseInput = [];

  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };

  const buildForeignResponsesItemId = (itemId: string): string => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };

  const normalizeToolCallId = (
    id: string,
    targetModel: Model<Api>,
    source: AssistantMessage,
  ): string => {
    if (!allowedToolCallProviders.has(targetModel.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall =
      source.provider !== targetModel.provider || source.api !== targetModel.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId as (id: string, model: Model<Api>, source: AssistantMessage) => string,
  );

  if (context.systemPrompt) {
    const role = model.reasoning ? "developer" : "system";
    messages.push({
      role,
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text),
            } satisfies ResponseInputText;
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          } satisfies ResponseInputImage;
        });
        const filteredContent = !model.input.includes("image")
          ? content.filter((c) => c.type !== "input_image")
          : content;
        if (filteredContent.length === 0) {
          continue;
        }
        messages.push({
          role: "user",
          content: filteredContent,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const assistantMsg = msg;
      const isDifferentModel =
        assistantMsg.model !== model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block;
          let msgId = textBlock.textSignature;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
          } as ResponseOutputMessage);
        } else if (block.type === "toolCall") {
          const toolCall = block;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          let itemId: string | undefined = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          });
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");

      let output: string | ResponseFunctionCallOutputItemList;
      if (hasImages && model.input.includes("image")) {
        const contentParts: ResponseFunctionCallOutputItemList = [];
        if (hasText) {
          contentParts.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
        }
        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`,
            });
          }
        }
        output = contentParts;
      } else {
        output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
      }

      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    msgIndex++;
  }

  return messages;
}

function convertResponsesTools(tools: Tool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    strict: null,
  }));
}

function mapStopReason(status: string | undefined): StopReason {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "queued":
    case "in_progress":
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

async function processResponsesStream(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: OpenAIResponsesOutput,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null =
    null;
  let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null =
    null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
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
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem?.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        const lastPart = currentItem.content?.[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        const lastPart = currentItem.content?.[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content
          .map((c) => (c.type === "output_text" ? c.text : c.refusal))
          .join("");
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(currentBlock.partialJson)
            : parseStreamingJson(item.arguments || "{}");
        const toolCall: ToolCall = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args,
        };

        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.id) {
        output.responseId = response.id;
      }
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      const errorMessage = event.message
        ? `Error Code ${event.code}: ${event.message}`
        : `Error Code ${event.code}: Unknown error`;
      throw new Error(errorMessage);
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
}

function resolveCodexWebSocketUrl(baseUrl: unknown): string {
  const raw =
    typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  const url = normalized.endsWith("/codex/responses")
    ? normalized
    : normalized.endsWith("/codex")
      ? `${normalized}/responses`
      : `${normalized}/codex/responses`;
  const parsed = new URL(url);
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  }
  return parsed.toString();
}

function buildRequestBody(model: Model<Api>, context: Context, options?: CodexProxyStreamOptions) {
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt,
    input: convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS),
    text: { verbosity: options?.textVerbosity || "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options?.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  if (typeof options?.temperature === "number") {
    body.temperature = options.temperature;
  }
  if (context.tools) {
    body.tools = convertResponsesTools(context.tools);
  }
  if (options?.reasoning) {
    body.reasoning = {
      effort: options.reasoning === "xhigh" ? "high" : options.reasoning,
      summary: options.reasoningSummary ?? "auto",
    };
  }

  return body;
}

function createCodexRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildWebSocketHeaders(params: {
  initHeaders?: Record<string, string>;
  additionalHeaders?: Record<string, string>;
  accountId: string;
  token: string;
  requestId: string;
}): Headers {
  const headers = new Headers(params.initHeaders);
  for (const [key, value] of Object.entries(params.additionalHeaders || {})) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${params.token}`);
  headers.set("chatgpt-account-id", params.accountId);
  headers.set("originator", "pi");
  headers.set("User-Agent", "pi (proxy)");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", params.requestId);
  headers.set("session_id", params.requestId);
  return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

function getWebSocketConstructor():
  | (new (url: string, init?: { headers?: Record<string, string> }) => WebSocketLike)
  | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof ctor === "function"
    ? (ctor as new (url: string, init?: { headers?: Record<string, string> }) => WebSocketLike)
    : null;
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<WebSocketLike> {
  const WebSocketCtor = getWebSocketConstructor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }
  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen: WebSocketListener = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError: WebSocketListener = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(extractWebSocketError(event));
    };
    const onClose: WebSocketListener = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(extractWebSocketCloseError(event));
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.close(1000, "aborted");
      reject(new Error("Request was aborted"));
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

function extractWebSocketError(event: unknown): Error {
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }
  }
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = "code" in event ? (event as { code?: unknown }).code : undefined;
    const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
    return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
  }
  return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

async function* parseWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;

  const wake = () => {
    if (!pending) {
      return;
    }
    const resolve = pending;
    pending = null;
    resolve();
  };

  const onMessage: WebSocketListener = (event) => {
    void (async () => {
      if (!event || typeof event !== "object" || !("data" in event)) {
        return;
      }
      const text = await decodeWebSocketData((event as { data?: unknown }).data);
      if (!text) {
        return;
      }
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.incomplete"
        ) {
          sawCompletion = true;
          done = true;
        }
        queue.push(parsed);
        wake();
      } catch {}
    })();
  };
  const onError: WebSocketListener = (event) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };
  const onClose: WebSocketListener = (event) => {
    if (!failed && !sawCompletion) {
      failed = extractWebSocketCloseError(event);
    }
    done = true;
    wake();
  };
  const onAbort = () => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (queue.length > 0) {
        yield queue.shift() as Record<string, unknown>;
        continue;
      }
      if (done) {
        break;
      }
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }

    if (failed) {
      throw failed;
    }
    if (!sawCompletion) {
      throw new Error("WebSocket stream closed before response.completed");
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<ResponseStreamEvent> {
  const knownStatuses = new Set<CodexResponseStatus>([
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "in_progress",
  ]);

  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) {
      continue;
    }
    if (type === "error") {
      const code = (event as { code?: string }).code || "";
      const message = (event as { message?: string }).message || "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const msg = (event as { response?: { error?: { message?: string } } }).response?.error
        ?.message;
      throw new Error(msg || "Codex response failed");
    }
    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete"
    ) {
      const response = (event as { response?: { status?: unknown } }).response;
      const normalizedResponse = response
        ? {
            ...response,
            status:
              typeof response.status === "string" &&
              knownStatuses.has(response.status as CodexResponseStatus)
                ? response.status
                : undefined,
          }
        : response;
      yield {
        ...event,
        type: "response.completed",
        response: normalizedResponse,
      } as ResponseStreamEvent;
      return;
    }
    yield event as unknown as ResponseStreamEvent;
  }
}

function streamCodexProxyResponses(
  model: Model<Api>,
  context: Context,
  options?: CodexProxyStreamOptions,
) {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: OpenAIResponsesOutput = {
      role: "assistant",
      content: [],
      api: "openai-codex-responses" as Api,
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
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody && typeof nextBody === "object") {
        body = nextBody;
      }

      const requestId = options?.sessionId || createCodexRequestId();
      const accountId = resolveSyntheticCodexAccountId({ model, headers: options?.headers });
      const headers = buildWebSocketHeaders({
        initHeaders: model.headers,
        additionalHeaders: options?.headers,
        accountId,
        token: apiKey,
        requestId,
      });

      const socket = await connectWebSocket(
        resolveCodexWebSocketUrl(model.baseUrl),
        headers,
        options?.signal,
      );

      socket.send(JSON.stringify({ type: "response.create", ...body }));
      stream.push({ type: "start", partial: output });
      await processResponsesStream(
        mapCodexEvents(parseWebSocket(socket, options?.signal)),
        output,
        stream,
      );
      socket.close(1000, "done");

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const doneReason: "length" | "stop" | "toolUse" =
        output.stopReason === "length"
          ? "length"
          : output.stopReason === "toolUse"
            ? "toolUse"
            : "stop";
      stream.push({ type: "done", reason: doneReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function createCodexProxyTransportWrapper(baseStreamFn?: StreamFn): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldUseProxyCodexTransport(model)) {
      return underlying(model, context, options);
    }
    return streamCodexProxyResponses(model, context, options as CodexProxyStreamOptions);
  };
}
