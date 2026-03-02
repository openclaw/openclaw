/**
 * OpenAI WebSocket StreamFn Integration
 *
 * Wraps `OpenAIWebSocketManager` in a `StreamFn` that can be plugged into the
 * pi-embedded-runner agent in place of the default `streamSimple` HTTP function.
 *
 * Key behaviours:
 *  - Per-session `OpenAIWebSocketManager` (keyed by sessionId)
 *  - Tracks `previous_response_id` to send only incremental tool-result inputs
 *  - Falls back to `streamSimple` (HTTP) if the WebSocket connection fails
 *  - Cleanup helpers for releasing sessions after the run completes
 *
 * Complexity budget & risk mitigation:
 *  - **Transport aware**: respects `transport` (`auto` | `websocket` | `sse`)
 *  - **Transparent fallback in `auto` mode**: connect/send failures fall back to
 *    the existing HTTP `streamSimple`; forced `websocket` mode surfaces WS errors
 *  - **Zero shared state**: per-session registry; session cleanup on dispose prevents leaks
 *  - **Full parity**: all generation options (temperature, top_p, max_output_tokens,
 *    tool_choice, reasoning) forwarded identically to the HTTP path
 *
 * @see src/agents/openai-ws-connection.ts for the connection manager
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import {
  OpenAIWebSocketManager,
  type ContentPart,
  type FunctionToolDefinition,
  type InputItem,
  type OpenAIWebSocketManagerOptions,
  type ResponseObject,
} from "./openai-ws-connection.js";
import { log } from "./pi-embedded-runner/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-session state
// ─────────────────────────────────────────────────────────────────────────────

interface WsSession {
  manager: OpenAIWebSocketManager;
  /** Number of messages that were in context.messages at the END of the last streamFn call. */
  lastContextLength: number;
  /** True if the connection has been established at least once. */
  everConnected: boolean;
  /** True once a best-effort warm-up attempt has run for this session. */
  warmUpAttempted: boolean;
  /** True if the session is permanently broken (no more reconnect). */
  broken: boolean;
}

/** Module-level registry: sessionId → WsSession */
const wsRegistry = new Map<string, WsSession>();

// ─────────────────────────────────────────────────────────────────────────────
// Public registry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Release and close the WebSocket session for the given sessionId.
 * Call this after the agent run completes to free the connection.
 */
export function releaseWsSession(sessionId: string): void {
  const session = wsRegistry.get(sessionId);
  if (session) {
    try {
      session.manager.close();
    } catch {
      // Ignore close errors — connection may already be gone.
    }
    wsRegistry.delete(sessionId);
  }
}

/**
 * Returns true if a live WebSocket session exists for the given sessionId.
 */
export function hasWsSession(sessionId: string): boolean {
  const s = wsRegistry.get(sessionId);
  return !!(s && !s.broken && s.manager.isConnected());
}

// ─────────────────────────────────────────────────────────────────────────────
// Message format converters
// ─────────────────────────────────────────────────────────────────────────────

type AnyMessage = Message & { role: string; content: unknown };

/** Convert pi-ai content (string | ContentPart[]) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type?: string; text?: string }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Convert pi-ai content to OpenAI ContentPart[]. */
function contentToOpenAIParts(content: unknown): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: ContentPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
    }
  }
  return parts;
}

/** Convert pi-ai tool array to OpenAI FunctionToolDefinition[]. */
export function convertTools(tools: Context["tools"]): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: (tool.parameters ?? {}) as Record<string, unknown>,
    },
  }));
}

/**
 * Convert the full pi-ai message history to an OpenAI `input` array.
 * Handles user messages, assistant text+tool-call messages, and tool results.
 */
export function convertMessagesToInputItems(messages: Message[]): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage;

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content);
      items.push({
        type: "message",
        role: "user",
        content:
          parts.length === 1 && parts[0]?.type === "input_text"
            ? (parts[0] as { type: "input_text"; text: string }).text
            : parts,
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = m.content;
      if (Array.isArray(content)) {
        // Collect text blocks and tool calls separately
        const textParts: string[] = [];
        for (const block of content as Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          arguments?: Record<string, unknown>;
          thinking?: string;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            // Skip thinking blocks — not sent back to the model
          } else if (block.type === "toolCall") {
            // Push accumulated text first
            if (textParts.length > 0) {
              items.push({
                type: "message",
                role: "assistant",
                content: textParts.join(""),
              });
              textParts.length = 0;
            }
            // Push function_call item
            items.push({
              type: "function_call",
              call_id: typeof block.id === "string" ? block.id : `call_${randomUUID()}`,
              name: block.name ?? "",
              arguments:
                typeof block.arguments === "string"
                  ? block.arguments
                  : JSON.stringify(block.arguments ?? {}),
            });
          }
        }
        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
          });
        }
      } else {
        const text = contentToText(m.content);
        if (text) {
          items.push({
            type: "message",
            role: "assistant",
            content: text,
          });
        }
      }
      continue;
    }

    if (m.role === "toolResult") {
      const tr = m as unknown as {
        toolCallId: string;
        content: unknown;
        isError: boolean;
      };
      const outputText = contentToText(tr.content);
      items.push({
        type: "function_call_output",
        call_id: tr.toolCallId,
        output: outputText,
      });
      continue;
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response object → AssistantMessage
// ─────────────────────────────────────────────────────────────────────────────

export function buildAssistantMessageFromResponse(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "toolCall",
        id: item.call_id,
        name: item.name,
        arguments: (() => {
          try {
            return JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })(),
      });
    }
    // "reasoning" items are informational only; skip.
  }

  const hasToolCalls = content.some((c) => c.type === "toolCall");
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  const usage: Usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage,
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamFn factory
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIWebSocketStreamOptions {
  /** Manager options (url override, retry counts, etc.) */
  managerOptions?: OpenAIWebSocketManagerOptions;
  /** Abort signal forwarded from the run. */
  signal?: AbortSignal;
}

type WsTransport = "sse" | "websocket" | "auto";
const WARM_UP_TIMEOUT_MS = 8_000;

function resolveWsTransport(options: Parameters<StreamFn>[2]): WsTransport {
  const transport = (options as { transport?: unknown } | undefined)?.transport;
  return transport === "sse" || transport === "websocket" || transport === "auto"
    ? transport
    : "auto";
}

type WsOptions = Parameters<StreamFn>[2] & { openaiWsWarmup?: unknown; signal?: AbortSignal };

function resolveWsWarmup(options: Parameters<StreamFn>[2]): boolean {
  const warmup = (options as WsOptions | undefined)?.openaiWsWarmup;
  return warmup === true;
}

async function runWarmUp(params: {
  manager: OpenAIWebSocketManager;
  modelId: string;
  tools: FunctionToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    throw new Error("aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS}ms`));
    }, WARM_UP_TIMEOUT_MS);

    const abortHandler = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const closeHandler = (code: number, reason: string) => {
      cleanup();
      reject(new Error(`warm-up closed (code=${code}, reason=${reason || "unknown"})`));
    };
    const unsubscribe = params.manager.onMessage((event) => {
      if (event.type === "response.completed") {
        cleanup();
        resolve();
      } else if (event.type === "response.failed") {
        cleanup();
        const errMsg = event.response?.error?.message ?? "Response failed";
        reject(new Error(`warm-up failed: ${errMsg}`));
      } else if (event.type === "error") {
        cleanup();
        reject(new Error(`warm-up error: ${event.message} (code=${event.code})`));
      }
    });

    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortHandler);
      params.manager.off("close", closeHandler);
      unsubscribe();
    };

    params.signal?.addEventListener("abort", abortHandler, { once: true });
    params.manager.on("close", closeHandler);
    params.manager.warmUp({
      model: params.modelId,
      tools: params.tools.length > 0 ? params.tools : undefined,
      instructions: params.instructions,
    });
  });
}

/**
 * Creates a `StreamFn` backed by a persistent WebSocket connection to the
 * OpenAI Responses API.  The first call for a given `sessionId` opens the
 * connection; subsequent calls reuse it, sending only incremental tool-result
 * inputs with `previous_response_id`.
 *
 * If the WebSocket connection is unavailable, the function falls back to the
 * standard `streamSimple` HTTP path and logs a warning.
 *
 * @param apiKey     OpenAI API key
 * @param sessionId  Agent session ID (used as the registry key)
 * @param opts       Optional manager + abort signal overrides
 */
export function createOpenAIWebSocketStreamFn(
  apiKey: string,
  sessionId: string,
  opts: OpenAIWebSocketStreamOptions = {},
): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();

    const run = async () => {
      const transport = resolveWsTransport(options);
      if (transport === "sse") {
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      // ── 1. Get or create session state ──────────────────────────────────
      let session = wsRegistry.get(sessionId);

      if (!session) {
        const manager = new OpenAIWebSocketManager(opts.managerOptions);
        session = {
          manager,
          lastContextLength: 0,
          everConnected: false,
          warmUpAttempted: false,
          broken: false,
        };
        wsRegistry.set(sessionId, session);
      }

      // ── 2. Ensure connection is open ─────────────────────────────────────
      if (!session.manager.isConnected() && !session.broken) {
        try {
          await session.manager.connect(apiKey);
          session.everConnected = true;
          log.debug(`[ws-stream] connected for session=${sessionId}`);
        } catch (connErr) {
          // Cancel any background reconnect attempts before marking as broken.
          try {
            session.manager.close();
          } catch {
            /* ignore */
          }
          session.broken = true;
          wsRegistry.delete(sessionId);
          if (transport === "websocket") {
            throw connErr instanceof Error ? connErr : new Error(String(connErr));
          }
          log.warn(
            `[ws-stream] WebSocket connect failed for session=${sessionId}; falling back to HTTP. error=${String(connErr)}`,
          );
          // Fall back to HTTP immediately
          return fallbackToHttp(model, context, options, eventStream, opts.signal);
        }
      }

      if (session.broken || !session.manager.isConnected()) {
        if (transport === "websocket") {
          throw new Error("WebSocket session disconnected");
        }
        log.warn(`[ws-stream] session=${sessionId} broken/disconnected; falling back to HTTP`);
        // Clean up stale session to prevent next turn from using stale
        // previousResponseId / lastContextLength after a mid-request drop.
        try {
          session.manager.close();
        } catch {
          /* ignore */
        }
        wsRegistry.delete(sessionId);
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      const signal = opts.signal ?? (options as WsOptions | undefined)?.signal;

      if (resolveWsWarmup(options) && !session.warmUpAttempted) {
        session.warmUpAttempted = true;
        try {
          await runWarmUp({
            manager: session.manager,
            modelId: model.id,
            tools: convertTools(context.tools),
            instructions: context.systemPrompt ?? undefined,
            signal,
          });
          log.debug(`[ws-stream] warm-up completed for session=${sessionId}`);
        } catch (warmErr) {
          if (signal?.aborted) {
            throw warmErr instanceof Error ? warmErr : new Error(String(warmErr));
          }
          log.warn(
            `[ws-stream] warm-up failed for session=${sessionId}; continuing without warm-up. error=${String(warmErr)}`,
          );
        }
      }

      // ── 3. Compute incremental vs full input ─────────────────────────────
      const prevResponseId = session.manager.previousResponseId;
      let inputItems: InputItem[];

      if (prevResponseId && session.lastContextLength > 0) {
        // Subsequent turn: only send new messages (tool results) since last call
        const newMessages = context.messages.slice(session.lastContextLength);
        // Filter to only tool results — the assistant message is already in server context
        const toolResults = newMessages.filter((m) => (m as AnyMessage).role === "toolResult");
        if (toolResults.length === 0) {
          // Shouldn't happen in a well-formed turn, but fall back to full context
          log.debug(
            `[ws-stream] session=${sessionId}: no new tool results found; sending full context`,
          );
          inputItems = buildFullInput(context);
        } else {
          inputItems = convertMessagesToInputItems(toolResults);
        }
        log.debug(
          `[ws-stream] session=${sessionId}: incremental send (${inputItems.length} tool results) previous_response_id=${prevResponseId}`,
        );
      } else {
        // First turn: send full context
        inputItems = buildFullInput(context);
        log.debug(
          `[ws-stream] session=${sessionId}: full context send (${inputItems.length} items)`,
        );
      }

      // ── 4. Build & send response.create ──────────────────────────────────
      const tools = convertTools(context.tools);

      // Forward generation options that the HTTP path (openai-responses provider) also uses.
      // Cast to record since SimpleStreamOptions carries openai-specific fields as unknown.
      const streamOpts = options as
        | (Record<string, unknown> & {
            temperature?: number;
            maxTokens?: number;
            topP?: number;
            toolChoice?: unknown;
          })
        | undefined;
      const extraParams: Record<string, unknown> = {};
      if (streamOpts?.temperature !== undefined) {
        extraParams.temperature = streamOpts.temperature;
      }
      if (streamOpts?.maxTokens) {
        extraParams.max_output_tokens = streamOpts.maxTokens;
      }
      if (streamOpts?.topP !== undefined) {
        extraParams.top_p = streamOpts.topP;
      }
      if (streamOpts?.toolChoice !== undefined) {
        extraParams.tool_choice = streamOpts.toolChoice;
      }
      if (streamOpts?.reasoningEffort || streamOpts?.reasoningSummary) {
        const reasoning: { effort?: string; summary?: string } = {};
        if (streamOpts.reasoningEffort !== undefined) {
          reasoning.effort = streamOpts.reasoningEffort as string;
        }
        if (streamOpts.reasoningSummary !== undefined) {
          reasoning.summary = streamOpts.reasoningSummary as string;
        }
        extraParams.reasoning = reasoning;
      }

      const payload: Record<string, unknown> = {
        type: "response.create",
        model: model.id,
        store: false,
        input: inputItems,
        instructions: context.systemPrompt ?? undefined,
        tools: tools.length > 0 ? tools : undefined,
        ...(prevResponseId ? { previous_response_id: prevResponseId } : {}),
        ...extraParams,
      };
      options?.onPayload?.(payload);

      try {
        session.manager.send(payload as Parameters<OpenAIWebSocketManager["send"]>[0]);
      } catch (sendErr) {
        if (transport === "websocket") {
          throw sendErr instanceof Error ? sendErr : new Error(String(sendErr));
        }
        log.warn(
          `[ws-stream] send failed for session=${sessionId}; falling back to HTTP. error=${String(sendErr)}`,
        );
        // Fully reset session state so the next WS turn doesn't use stale
        // previous_response_id or lastContextLength from before the failure.
        try {
          session.manager.close();
        } catch {
          /* ignore */
        }
        wsRegistry.delete(sessionId);
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      eventStream.push({
        type: "start",
        partial: {
          role: "assistant",
          content: [],
          stopReason: "stop",
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

      // ── 5. Wait for response.completed ───────────────────────────────────
      const capturedContextLength = context.messages.length;

      await new Promise<void>((resolve, reject) => {
        // Honour abort signal
        const abortHandler = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", abortHandler, { once: true });

        // If the WebSocket drops mid-request, reject so we don't hang forever.
        const closeHandler = (code: number, reason: string) => {
          cleanup();
          reject(
            new Error(`WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`),
          );
        };
        session.manager.on("close", closeHandler);

        const cleanup = () => {
          signal?.removeEventListener("abort", abortHandler);
          session.manager.off("close", closeHandler);
          unsubscribe();
        };

        const unsubscribe = session.manager.onMessage((event) => {
          if (event.type === "response.completed") {
            cleanup();
            // Update session state
            session.lastContextLength = capturedContextLength;
            // Build and emit the assistant message
            const assistantMsg = buildAssistantMessageFromResponse(event.response, {
              api: model.api,
              provider: model.provider,
              id: model.id,
            });
            const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
              assistantMsg.stopReason === "toolUse" ? "toolUse" : "stop";
            eventStream.push({ type: "done", reason, message: assistantMsg });
            resolve();
          } else if (event.type === "response.failed") {
            cleanup();
            const errMsg = event.response?.error?.message ?? "Response failed";
            reject(new Error(`OpenAI WebSocket response failed: ${errMsg}`));
          } else if (event.type === "error") {
            cleanup();
            reject(new Error(`OpenAI WebSocket error: ${event.message} (code=${event.code})`));
          } else if (event.type === "response.output_text.delta") {
            // Stream partial text updates for responsive UI
            const partialMsg: AssistantMessage = {
              role: "assistant",
              content: [{ type: "text", text: event.delta }],
              stopReason: "stop",
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
            };
            eventStream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: event.delta,
              partial: partialMsg,
            });
          }
        });
      });
    };

    queueMicrotask(() =>
      run().catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[ws-stream] session=${sessionId} run error: ${errorMessage}`);
        eventStream.push({
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
        eventStream.end();
      }),
    );

    return eventStream;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build full input items from context (system prompt is passed via `instructions` field). */
function buildFullInput(context: Context): InputItem[] {
  return convertMessagesToInputItems(context.messages);
}

/**
 * Fall back to HTTP (`streamSimple`) and pipe events into the existing stream.
 * This is called when the WebSocket is broken or unavailable.
 */
async function fallbackToHttp(
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  eventStream: ReturnType<typeof createAssistantMessageEventStream>,
  signal?: AbortSignal,
): Promise<void> {
  const mergedOptions = signal ? { ...options, signal } : options;
  const httpStream = streamSimple(model, context, mergedOptions);
  for await (const event of httpStream) {
    eventStream.push(event);
  }
}
