import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("bedrock-invoke-stream");

// ── Anthropic Messages request types (Bedrock subset) ───────────────────────

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface BedrockInvokeRequest {
  anthropic_version: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  temperature?: number;
}

// ── SSE event types from Anthropic stream ───────────────────────────────────

interface SseMessageStart {
  type: "message_start";
  message: {
    id: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

interface SseContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: string };
}

interface SseContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "input_json_delta"; partial_json: string };
}

interface SseContentBlockStop {
  type: "content_block_stop";
  index: number;
}

interface SseMessageDelta {
  type: "message_delta";
  delta: { stop_reason?: string };
  usage?: { output_tokens?: number };
}

interface SseMessageStop {
  type: "message_stop";
}

export type SseEvent =
  | SseMessageStart
  | SseContentBlockStart
  | SseContentBlockDelta
  | SseContentBlockStop
  | SseMessageDelta
  | SseMessageStop
  | { type: "ping" };

// ── Message conversion ──────────────────────────────────────────────────────

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "toolResult"; toolCallId: string; content: unknown };

export function convertMessages(
  messages: Array<{ role: string; content: unknown }>,
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const { role, content } = msg;

    if (role === "user") {
      if (typeof content === "string") {
        result.push({ role: "user", content });
      } else if (Array.isArray(content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const part of content as InputContentPart[]) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text });
          } else if (part.type === "image") {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType ?? "image/png",
                data: part.data,
              },
            });
          }
        }
        result.push({ role: "user", content: blocks.length > 0 ? blocks : "" });
      } else {
        result.push({ role: "user", content: "" });
      }
    } else if (role === "assistant") {
      if (typeof content === "string") {
        result.push({ role: "assistant", content });
      } else if (Array.isArray(content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const part of content as InputContentPart[]) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text });
          } else if (part.type === "toolCall") {
            blocks.push({
              type: "tool_use",
              id: part.id,
              name: part.name,
              input: part.arguments,
            });
          } else if (part.type === "tool_use") {
            blocks.push({
              type: "tool_use",
              id: part.id,
              name: part.name,
              input: part.input,
            });
          }
        }
        result.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      } else {
        result.push({ role: "assistant", content: "" });
      }
    } else if (role === "tool" || role === "toolResult") {
      // Tool results in Anthropic format go as user messages with tool_result blocks
      const toolCallId =
        typeof (msg as { toolCallId?: unknown }).toolCallId === "string"
          ? ((msg as { toolCallId?: string }).toolCallId ?? `tool_${randomUUID()}`)
          : `tool_${randomUUID()}`;
      const text = typeof content === "string" ? content : extractTextFromContent(content);
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolCallId, content: text }],
      });
    }
  }

  return result;
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("");
}

export function convertTools(tools: Tool[] | undefined): AnthropicTool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: AnthropicTool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    });
  }
  return result;
}

// ── AWS binary event stream parser ──────────────────────────────────────────
//
// The Bedrock invoke-with-response-stream endpoint returns
// `application/vnd.amazon.eventstream` — a binary framing protocol.
//
// Each frame:
//   [4B total_len] [4B headers_len] [4B prelude_crc]
//   [headers...]   [payload...]     [4B message_crc]
//
// Headers are type-tagged key-value pairs; we only care about the payload.
// For Bedrock, the payload is JSON: {"bytes":"<base64>"} where the base64
// decodes to standard Anthropic JSON events (message_start, content_block_delta, etc.).

const EVENT_STREAM_PRELUDE_SIZE = 12; // 4 + 4 + 4
const EVENT_STREAM_CRC_SIZE = 4;

/**
 * Parse AWS binary event stream frames from a ReadableStream and yield
 * the decoded Anthropic JSON events.
 */
export async function* parseAwsEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseEvent> {
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();

  function appendToBuffer(chunk: Uint8Array): void {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
  }

  function readUint32(offset: number): number {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return view.getUint32(offset);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    appendToBuffer(value);

    // Try to extract complete frames from the buffer
    while (buffer.length >= EVENT_STREAM_PRELUDE_SIZE) {
      const totalLength = readUint32(0);
      const headersLength = readUint32(4);

      if (totalLength < EVENT_STREAM_PRELUDE_SIZE + EVENT_STREAM_CRC_SIZE) {
        // Malformed frame; skip 1 byte and resync
        log.warn(`Malformed event stream frame (totalLength=${totalLength}), skipping`);
        buffer = buffer.slice(1);
        continue;
      }

      if (buffer.length < totalLength) {
        // Incomplete frame; wait for more data
        break;
      }

      // Extract payload (between headers and trailing CRC)
      const payloadStart = EVENT_STREAM_PRELUDE_SIZE + headersLength;
      const payloadEnd = totalLength - EVENT_STREAM_CRC_SIZE;
      const payloadBytes = buffer.slice(payloadStart, payloadEnd);

      // Advance buffer past this frame
      buffer = buffer.slice(totalLength);

      if (payloadBytes.length === 0) {
        continue;
      }

      const payloadStr = decoder.decode(payloadBytes);

      try {
        const envelope = JSON.parse(payloadStr) as { bytes?: string };
        if (!envelope.bytes) {
          continue;
        }

        // Decode the base64 inner event
        const innerJson = Buffer.from(envelope.bytes, "base64").toString("utf-8");
        const event = JSON.parse(innerJson) as SseEvent;
        yield event;
      } catch {
        // Some frames may be error events or non-JSON; log and skip
        log.debug(`Skipping non-JSON event stream payload: ${payloadStr.slice(0, 120)}`);
      }
    }
  }
}

// ── Accumulated content block tracking ──────────────────────────────────────

interface ContentBlockAccumulator {
  type: "text" | "thinking" | "tool_use";
  text: string;
  // For tool_use blocks
  toolId?: string;
  toolName?: string;
  inputJson?: string;
}

// ── Main StreamFn factory ───────────────────────────────────────────────────

export function createBedrockInvokeStreamFn(baseUrl: string): StreamFn {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const messages = convertMessages(context.messages ?? []);
        const tools = convertTools(context.tools);

        const body: BedrockInvokeRequest = {
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: options?.maxTokens ?? model.maxTokens ?? 4096,
          messages,
          ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
          ...(tools.length > 0 ? { tools } : {}),
        };

        if (typeof options?.temperature === "number") {
          body.temperature = options.temperature;
        }

        const url = `${trimmedBase}/model/${model.id}/invoke-with-response-stream`;
        log.debug(`POST ${url}`);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...options?.headers,
        };
        if (options?.apiKey) {
          // Corporate Bedrock proxies (e.g. Kong-based) typically expect
          // both Authorization and api-key headers for routing/auth.
          headers.Authorization = `Bearer ${options.apiKey}`;
          headers["api-key"] = options.apiKey;
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Bedrock invoke API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Bedrock invoke API returned empty response body");
        }

        const reader = response.body.getReader();
        const blocks: ContentBlockAccumulator[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: string | undefined;

        for await (const event of parseAwsEventStream(reader)) {
          switch (event.type) {
            case "message_start": {
              const usage = event.message?.usage;
              if (usage?.input_tokens) {
                inputTokens = usage.input_tokens;
              }
              break;
            }
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "text") {
                blocks[event.index] = { type: "text", text: block.text ?? "" };
              } else if (block.type === "thinking") {
                blocks[event.index] = { type: "thinking", text: block.thinking ?? "" };
              } else if (block.type === "tool_use") {
                blocks[event.index] = {
                  type: "tool_use",
                  text: "",
                  toolId: block.id,
                  toolName: block.name,
                  inputJson: "",
                };
              }
              break;
            }
            case "content_block_delta": {
              const acc = blocks[event.index];
              if (!acc) {
                break;
              }
              if (event.delta.type === "text_delta") {
                acc.text += event.delta.text;
              } else if (event.delta.type === "thinking_delta") {
                acc.text += event.delta.thinking;
              } else if (event.delta.type === "input_json_delta") {
                acc.inputJson = (acc.inputJson ?? "") + event.delta.partial_json;
              }
              break;
            }
            case "content_block_stop": {
              // Block finalized; nothing extra needed
              break;
            }
            case "message_delta": {
              if (event.delta.stop_reason) {
                stopReason = event.delta.stop_reason;
              }
              if (event.usage?.output_tokens) {
                outputTokens = event.usage.output_tokens;
              }
              break;
            }
            case "message_stop": {
              // Stream complete
              break;
            }
          }
        }

        // Build AssistantMessage from accumulated blocks
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];
        for (const block of blocks) {
          if (!block) {
            continue;
          }
          if (block.type === "text" && block.text) {
            contentParts.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && block.text) {
            contentParts.push({
              type: "thinking",
              thinking: block.text,
            } as ThinkingContent);
          } else if (block.type === "tool_use") {
            let args: Record<string, unknown> = {};
            if (block.inputJson) {
              try {
                args = JSON.parse(block.inputJson) as Record<string, unknown>;
              } catch {
                log.warn(`Failed to parse tool input JSON for ${block.toolName}`);
              }
            }
            contentParts.push({
              type: "toolCall",
              id: block.toolId ?? `bedrock_call_${randomUUID()}`,
              name: block.toolName ?? "unknown",
              arguments: args,
            });
          }
        }

        const hasToolCalls = contentParts.some((p) => p.type === "toolCall");
        const resolvedStopReason: StopReason =
          stopReason === "tool_use" || hasToolCalls ? "toolUse" : "stop";

        const usage: Usage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: contentParts,
          stopReason: resolvedStopReason,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          timestamp: Date.now(),
        };

        const doneReason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          resolvedStopReason === "toolUse" ? "toolUse" : "stop";

        stream.push({
          type: "done",
          reason: doneReason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`Bedrock invoke stream error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
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
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
