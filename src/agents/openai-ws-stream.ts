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
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import {
  OpenAIWebSocketManager,
  type ContentPart,
  type FunctionToolDefinition,
  type InputItem,
  type OpenAIResponsesAssistantPhase,
  type OpenAIWebSocketManagerOptions,
  type ResponseObject,
} from "./openai-ws-connection.js";
import { log } from "./pi-embedded-runner/logger.js";
import {
  buildAssistantMessage,
  buildAssistantMessageWithZeroUsage,
  buildUsageWithNoCost,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

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
type AssistantMessageWithPhase = AssistantMessage & { phase?: OpenAIResponsesAssistantPhase };
type ReplayModelInfo = { input?: ReadonlyArray<string> };

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAssistantPhase(value: unknown): OpenAIResponsesAssistantPhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function encodeAssistantTextSignature(params: {
  id: string;
  phase?: OpenAIResponsesAssistantPhase;
}): string {
  return JSON.stringify({
    v: 1,
    id: params.id,
    ...(params.phase ? { phase: params.phase } : {}),
  });
}

function parseAssistantTextSignature(
  value: unknown,
): { id: string; phase?: OpenAIResponsesAssistantPhase } | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  if (!value.startsWith("{")) {
    return { id: value };
  }
  try {
    const parsed = JSON.parse(value) as { v?: unknown; id?: unknown; phase?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      ...(normalizeAssistantPhase(parsed.phase)
        ? { phase: normalizeAssistantPhase(parsed.phase) }
        : {}),
    };
  } catch {
    return null;
  }
}

function supportsImageInput(modelOverride?: ReplayModelInfo): boolean {
  return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}

/** Convert pi-ai content (string | ContentPart[]) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object",
    )
    .filter(
      (part) =>
        (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

/** Convert pi-ai content to OpenAI ContentPart[]. */
function contentToOpenAIParts(content: unknown, modelOverride?: ReplayModelInfo): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const includeImages = supportsImageInput(modelOverride);
  const parts: ContentPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    source?: unknown;
  }>) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    if (!includeImages) {
      continue;
    }

    if (part.type === "image" && typeof part.data === "string") {
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
      continue;
    }

    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      typeof (part.source as { type?: unknown }).type === "string"
    ) {
      parts.push({
        type: "input_image",
        source: part.source as
          | { type: "url"; url: string }
          | { type: "base64"; media_type: string; data: string },
      });
    }
  }
  return parts;
}

function parseReasoningItem(value: unknown): Extract<InputItem, { type: "reasoning" }> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    type?: unknown;
    content?: unknown;
    encrypted_content?: unknown;
    summary?: unknown;
  };
  if (record.type !== "reasoning") {
    return null;
  }
  return {
    type: "reasoning",
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.encrypted_content === "string"
      ? { encrypted_content: record.encrypted_content }
      : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function parseThinkingSignature(value: unknown): Extract<InputItem, { type: "reasoning" }> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return parseReasoningItem(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Convert pi-ai tool array to OpenAI FunctionToolDefinition[]. */
export function convertTools(tools: Context["tools"]): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : undefined,
    parameters: (tool.parameters ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Convert the full pi-ai message history to an OpenAI `input` array.
 * Handles user messages, assistant text+tool-call messages, and tool results.
 */
export function convertMessagesToInputItems(
  messages: Message[],
  modelOverride?: ReplayModelInfo,
): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage & {
      phase?: unknown;
      toolCallId?: unknown;
      toolUseId?: unknown;
    };

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content, modelOverride);
      if (parts.length === 0) {
        continue;
      }
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
      let assistantPhase = normalizeAssistantPhase(m.phase);
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const pushAssistantText = () => {
          if (textParts.length === 0) {
            return;
          }
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
            ...(assistantPhase ? { phase: assistantPhase } : {}),
          });
          textParts.length = 0;
        };

        for (const block of content as Array<{
          type?: string;
          text?: string;
          textSignature?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
          thinkingSignature?: unknown;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            const parsedSignature = parseAssistantTextSignature(block.textSignature);
            if (!assistantPhase) {
              assistantPhase = parsedSignature?.phase;
            }
            textParts.push(block.text);
            continue;
          }

          if (block.type === "thinking") {
            pushAssistantText();
            const reasoningItem = parseThinkingSignature(block.thinkingSignature);
            if (reasoningItem) {
              items.push(reasoningItem);
            }
            continue;
          }

          if (block.type !== "toolCall") {
            continue;
          }

          pushAssistantText();
          const callIdRaw = toNonEmptyString(block.id);
          const toolName = toNonEmptyString(block.name);
          if (!callIdRaw || !toolName) {
            continue;
          }
          const [callId, itemId] = callIdRaw.split("|", 2);
          items.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: toolName,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }

        pushAssistantText();
        continue;
      }

      const text = contentToText(content);
      if (!text) {
        continue;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: text,
        ...(assistantPhase ? { phase: assistantPhase } : {}),
      });
      continue;
    }

    if (m.role !== "toolResult") {
      continue;
    }

    const toolCallId = toNonEmptyString(m.toolCallId) ?? toNonEmptyString(m.toolUseId);
    if (!toolCallId) {
      continue;
    }
    const [callId] = toolCallId.split("|", 2);
    const parts = Array.isArray(m.content) ? contentToOpenAIParts(m.content, modelOverride) : [];
    const textOutput = contentToText(m.content);
    const imageParts = parts.filter((part) => part.type === "input_image");
    items.push({
      type: "function_call_output",
      call_id: callId,
      output: textOutput || (imageParts.length > 0 ? "(see attached image)" : ""),
    });
    if (imageParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          ...imageParts,
        ],
      });
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
  let assistantPhase: OpenAIResponsesAssistantPhase | undefined;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      const itemPhase = normalizeAssistantPhase(item.phase);
      if (itemPhase) {
        assistantPhase = itemPhase;
      }
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({
            type: "text",
            text: part.text,
            textSignature: encodeAssistantTextSignature({
              id: item.id,
              ...(itemPhase ? { phase: itemPhase } : {}),
            }),
          });
        }
      }
    } else if (item.type === "function_call") {
      const toolName = toNonEmptyString(item.name);
      if (!toolName) {
        continue;
      }
      content.push({
        type: "toolCall",
        id: toNonEmptyString(item.call_id) ?? `call_${randomUUID()}`,
        name: toolName,
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

  const message = buildAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: response.usage?.input_tokens ?? 0,
      // vLLM uses completion_tokens, not output_tokens
      output: response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    }),
  });

  return assistantPhase
    ? ({ ...message, phase: assistantPhase } as AssistantMessageWithPhase)
    : message;
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
        let warmupFailed = false;
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
          warmupFailed = true;
          log.warn(
            `[ws-stream] warm-up failed for session=${sessionId}; continuing without warm-up. error=${String(warmErr)}`,
          );
        }
        if (warmupFailed && !session.manager.isConnected()) {
          try {
            session.manager.close();
          } catch {
            /* ignore */
          }
          try {
            await session.manager.connect(apiKey);
            session.everConnected = true;
            log.debug(`[ws-stream] reconnected after warm-up failure for session=${sessionId}`);
          } catch (reconnectErr) {
            session.broken = true;
            wsRegistry.delete(sessionId);
            if (transport === "websocket") {
              throw reconnectErr instanceof Error ? reconnectErr : new Error(String(reconnectErr));
            }
            log.warn(
              `[ws-stream] reconnect after warm-up failed for session=${sessionId}; falling back to HTTP. error=${String(reconnectErr)}`,
            );
            return fallbackToHttp(model, context, options, eventStream, opts.signal);
          }
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
          inputItems = buildFullInput(context, model);
        } else {
          inputItems = convertMessagesToInputItems(toolResults, model);
        }
        log.debug(
          `[ws-stream] session=${sessionId}: incremental send (${inputItems.length} tool results) previous_response_id=${prevResponseId}`,
        );
      } else {
        // First turn: send full context
        inputItems = buildFullInput(context, model);
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
      if (streamOpts?.maxTokens !== undefined) {
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

      // Respect compat.supportsStore — providers like Gemini reject unknown
      // fields such as `store` with a 400 error.  Fixes #39086.
      const supportsStore = (model as { compat?: { supportsStore?: boolean } }).compat
        ?.supportsStore;

      const payload: Record<string, unknown> = {
        type: "response.create",
        model: model.id,
        ...(supportsStore !== false ? { store: false } : {}),
        input: inputItems,
        instructions: context.systemPrompt ?? undefined,
        tools: tools.length > 0 ? tools : undefined,
        ...(prevResponseId ? { previous_response_id: prevResponseId } : {}),
        ...extraParams,
      };
      const nextPayload = options?.onPayload?.(payload, model);
      const requestPayload = (nextPayload ?? payload) as Parameters<
        OpenAIWebSocketManager["send"]
      >[0];

      try {
        session.manager.send(requestPayload);
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
        partial: buildAssistantMessageWithZeroUsage({
          model,
          content: [],
          stopReason: "stop",
        }),
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
            const partialMsg: AssistantMessage = buildAssistantMessageWithZeroUsage({
              model,
              content: [{ type: "text", text: event.delta }],
              stopReason: "stop",
            });
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
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
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
function buildFullInput(context: Context, model: ReplayModelInfo): InputItem[] {
  return convertMessagesToInputItems(context.messages, model);
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
