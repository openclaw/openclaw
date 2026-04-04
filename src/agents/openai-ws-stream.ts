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

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  StopReason,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import {
  getOpenAIWebSocketErrorDetails,
  OpenAIWebSocketManager,
  type FunctionToolDefinition,
  type OpenAIWebSocketManagerOptions,
} from "./openai-ws-connection.js";
import {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  planTurnInput,
} from "./openai-ws-message-conversion.js";
import { buildOpenAIWebSocketResponseCreatePayload } from "./openai-ws-request.js";
import { log } from "./pi-embedded-runner/logger.js";
import {
  buildAssistantMessageWithZeroUsage,
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

type OpenAIWsStreamDeps = {
  createManager: (options?: OpenAIWebSocketManagerOptions) => OpenAIWebSocketManager;
  streamSimple: typeof piAi.streamSimple;
};

const defaultOpenAIWsStreamDeps: OpenAIWsStreamDeps = {
  createManager: (options) => new OpenAIWebSocketManager(options),
  streamSimple: (...args) => piAi.streamSimple(...args),
};

let openAIWsStreamDeps: OpenAIWsStreamDeps = defaultOpenAIWsStreamDeps;

type AssistantMessageEventStreamLike = {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
};

class LocalAssistantMessageEventStream implements AssistantMessageEventStreamLike {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private readonly finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (result: AssistantMessage) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) {
      return;
    }
    if (event.type === "done") {
      this.done = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined as unknown as AssistantMessageEvent, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}

function createEventStream(): AssistantMessageEventStream {
  return typeof piAi.createAssistantMessageEventStream === "function"
    ? piAi.createAssistantMessageEventStream()
    : (new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream);
}

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

export {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  planTurnInput,
} from "./openai-ws-message-conversion.js";

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
const MAX_AUTO_WS_RUNTIME_RETRIES = 1;

class OpenAIWebSocketRuntimeError extends Error {
  readonly kind: "disconnect" | "send" | "server";
  readonly retryable: boolean;
  readonly closeCode?: number;
  readonly closeReason?: string;

  constructor(
    message: string,
    params: {
      kind: "disconnect" | "send" | "server";
      retryable: boolean;
      closeCode?: number;
      closeReason?: string;
    },
  ) {
    super(message);
    this.name = "OpenAIWebSocketRuntimeError";
    this.kind = params.kind;
    this.retryable = params.retryable;
    this.closeCode = params.closeCode;
    this.closeReason = params.closeReason;
  }
}

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

function resetWsSession(params: { sessionId: string; session: WsSession }): void {
  try {
    params.session.manager.close();
  } catch {
    /* ignore */
  }
  wsRegistry.delete(params.sessionId);
}

function formatOpenAIWebSocketError(
  event: Parameters<OpenAIWebSocketManager["onMessage"]>[0] extends (arg: infer T) => void
    ? Extract<T, { type: "error" }>
    : never,
): string {
  const details = getOpenAIWebSocketErrorDetails(event);
  const code = details.code ?? "unknown";
  const message = details.message ?? "Unknown error";
  const extras = [
    typeof details.status === "number" ? `status=${details.status}` : null,
    details.type ? `type=${details.type}` : null,
    details.param ? `param=${details.param}` : null,
  ].filter(Boolean);
  return extras.length > 0
    ? `${message} (code=${code}; ${extras.join(", ")})`
    : `${message} (code=${code})`;
}

function formatOpenAIWebSocketResponseFailure(response: {
  error?: { code?: string; message?: string };
  incomplete_details?: { reason?: string };
}): string {
  if (response.error) {
    return `${response.error.code || "unknown"}: ${response.error.message || "no message"}`;
  }
  if (response.incomplete_details?.reason) {
    return `incomplete: ${response.incomplete_details.reason}`;
  }
  return "Unknown error (no error details in response)";
}

function normalizeWsRunError(err: unknown): OpenAIWebSocketRuntimeError {
  if (err instanceof OpenAIWebSocketRuntimeError) {
    return err;
  }
  return new OpenAIWebSocketRuntimeError(err instanceof Error ? err.message : String(err), {
    kind: "server",
    retryable: false,
  });
}

function buildRetryableSendError(err: unknown): OpenAIWebSocketRuntimeError {
  return new OpenAIWebSocketRuntimeError(
    err instanceof Error ? err.message : `WebSocket send failed: ${String(err)}`,
    {
      kind: "send",
      retryable: true,
    },
  );
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
        reject(
          new Error(`warm-up failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`),
        );
      } else if (event.type === "error") {
        cleanup();
        reject(new Error(`warm-up error: ${formatOpenAIWebSocketError(event)}`));
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
    const eventStream = createEventStream();

    const run = async () => {
      const transport = resolveWsTransport(options);
      if (transport === "sse") {
        return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal);
      }

      const signal = opts.signal ?? (options as WsOptions | undefined)?.signal;
      let emittedStart = false;
      let runtimeRetries = 0;

      while (true) {
        let session = wsRegistry.get(sessionId);
        if (!session) {
          const manager = openAIWsStreamDeps.createManager(opts.managerOptions);
          session = {
            manager,
            lastContextLength: 0,
            everConnected: false,
            warmUpAttempted: false,
            broken: false,
          };
          wsRegistry.set(sessionId, session);
        }

        if (!session.manager.isConnected() && !session.broken) {
          try {
            await session.manager.connect(apiKey);
            session.everConnected = true;
            log.debug(`[ws-stream] connected for session=${sessionId}`);
          } catch (connErr) {
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
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: emittedStart,
            });
          }
        }

        if (session.broken || !session.manager.isConnected()) {
          if (transport === "websocket") {
            throw new Error("WebSocket session disconnected");
          }
          log.warn(`[ws-stream] session=${sessionId} broken/disconnected; falling back to HTTP`);
          resetWsSession({ sessionId, session });
          return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
            suppressStart: emittedStart,
          });
        }

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
                throw reconnectErr instanceof Error
                  ? reconnectErr
                  : new Error(String(reconnectErr));
              }
              log.warn(
                `[ws-stream] reconnect after warm-up failed for session=${sessionId}; falling back to HTTP. error=${String(reconnectErr)}`,
              );
              return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
                suppressStart: emittedStart,
              });
            }
          }
        }

        const turnInput = planTurnInput({
          context,
          model,
          previousResponseId: session.manager.previousResponseId,
          lastContextLength: session.lastContextLength,
        });

        if (turnInput.mode === "incremental_tool_results") {
          log.debug(
            `[ws-stream] session=${sessionId}: incremental send (${turnInput.inputItems.length} tool results) previous_response_id=${turnInput.previousResponseId}`,
          );
        } else if (turnInput.mode === "full_context_restart") {
          log.debug(
            `[ws-stream] session=${sessionId}: no new tool results found; sending full context without previous_response_id`,
          );
        } else {
          log.debug(
            `[ws-stream] session=${sessionId}: full context send (${turnInput.inputItems.length} items)`,
          );
        }

        const payload = buildOpenAIWebSocketResponseCreatePayload({
          model,
          context,
          options: options as WsOptions | undefined,
          turnInput,
          tools: convertTools(context.tools),
        }) as Record<string, unknown>;
        const nextPayload = options?.onPayload?.(payload, model);
        const requestPayload = (nextPayload ?? payload) as Parameters<
          OpenAIWebSocketManager["send"]
        >[0];

        try {
          session.manager.send(requestPayload);
        } catch (sendErr) {
          const normalizedErr = buildRetryableSendError(sendErr);
          if (
            transport !== "websocket" &&
            !signal?.aborted &&
            runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES
          ) {
            runtimeRetries++;
            log.warn(
              `[ws-stream] retrying websocket turn after send failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`,
            );
            resetWsSession({ sessionId, session });
            continue;
          }
          if (transport !== "websocket") {
            log.warn(
              `[ws-stream] send failed for session=${sessionId}; falling back to HTTP. error=${normalizedErr.message}`,
            );
            resetWsSession({ sessionId, session });
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: emittedStart,
            });
          }
          throw normalizedErr;
        }

        if (!emittedStart) {
          eventStream.push({
            type: "start",
            partial: buildAssistantMessageWithZeroUsage({
              model,
              content: [],
              stopReason: "stop",
            }),
          });
          emittedStart = true;
        }

        const capturedContextLength = context.messages.length;
        let sawWsOutput = false;

        try {
          await new Promise<void>((resolve, reject) => {
            const abortHandler = () => {
              cleanup();
              reject(new Error("aborted"));
            };
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal?.addEventListener("abort", abortHandler, { once: true });

            const closeHandler = (code: number, reason: string) => {
              cleanup();
              const closeInfo = session.manager.lastCloseInfo;
              reject(
                new OpenAIWebSocketRuntimeError(
                  `WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`,
                  {
                    kind: "disconnect",
                    retryable: closeInfo?.retryable ?? true,
                    closeCode: closeInfo?.code ?? code,
                    closeReason: closeInfo?.reason ?? reason,
                  },
                ),
              );
            };
            session.manager.on("close", closeHandler);

            const cleanup = () => {
              signal?.removeEventListener("abort", abortHandler);
              session.manager.off("close", closeHandler);
              unsubscribe();
            };

            const unsubscribe = session.manager.onMessage((event) => {
              if (
                event.type === "response.output_item.added" ||
                event.type === "response.output_item.done" ||
                event.type === "response.content_part.added" ||
                event.type === "response.content_part.done" ||
                event.type === "response.output_text.delta" ||
                event.type === "response.output_text.done" ||
                event.type === "response.function_call_arguments.delta" ||
                event.type === "response.function_call_arguments.done"
              ) {
                sawWsOutput = true;
              }

              if (event.type === "response.completed") {
                cleanup();
                session.lastContextLength = capturedContextLength;
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
                reject(
                  new OpenAIWebSocketRuntimeError(
                    `OpenAI WebSocket response failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`,
                    {
                      kind: "server",
                      retryable: false,
                    },
                  ),
                );
              } else if (event.type === "error") {
                cleanup();
                reject(
                  new OpenAIWebSocketRuntimeError(
                    `OpenAI WebSocket error: ${formatOpenAIWebSocketError(event)}`,
                    {
                      kind: "server",
                      retryable: false,
                    },
                  ),
                );
              } else if (event.type === "response.output_text.delta") {
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
          return;
        } catch (wsRunErr) {
          const normalizedErr = normalizeWsRunError(wsRunErr);
          if (
            transport !== "websocket" &&
            !signal?.aborted &&
            normalizedErr.retryable &&
            !sawWsOutput &&
            runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES
          ) {
            runtimeRetries++;
            log.warn(
              `[ws-stream] retrying websocket turn after retryable runtime failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`,
            );
            resetWsSession({ sessionId, session });
            continue;
          }
          if (transport !== "websocket" && !signal?.aborted && !sawWsOutput) {
            log.warn(
              `[ws-stream] session=${sessionId} runtime failure before output; falling back to HTTP. error=${normalizedErr.message}`,
            );
            resetWsSession({ sessionId, session });
            return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
              suppressStart: true,
            });
          }
          throw normalizedErr;
        }
      }
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

/**
 * Fall back to HTTP (`streamSimple`) and pipe events into the existing stream.
 * This is called when the WebSocket is broken or unavailable.
 */
async function fallbackToHttp(
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  streamOptions: Parameters<StreamFn>[2],
  apiKey: string,
  eventStream: AssistantMessageEventStreamLike,
  signal?: AbortSignal,
  fallbackOptions?: { suppressStart?: boolean },
): Promise<void> {
  const mergedOptions = {
    ...streamOptions,
    apiKey,
    ...(signal ? { signal } : {}),
  };
  const httpStream = openAIWsStreamDeps.streamSimple(model, context, mergedOptions);
  for await (const event of httpStream) {
    if (fallbackOptions?.suppressStart && event.type === "start") {
      continue;
    }
    eventStream.push(event);
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<OpenAIWsStreamDeps>) {
    openAIWsStreamDeps = overrides
      ? {
          ...defaultOpenAIWsStreamDeps,
          ...overrides,
        }
      : defaultOpenAIWsStreamDeps;
  },
};
