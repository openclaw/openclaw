/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
  createToolArgumentPreviewSchedule,
  createSseByteGuard,
  parseStreamingJson,
  parseTerminalToolCallArguments,
  type ToolArgumentPreviewSchedule,
} from "@openclaw/ai/internal/runtime";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { readResponseWithLimit } from "../../infra/http-body.js";
import { withResponseBodyTimeout } from "../../infra/http-response-body-timeout.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
} from "../../llm/types.js";
import { AssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { makeZeroUsageSnapshot } from "../usage.js";

const PROXY_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_SSE_STREAM_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_SSE_PENDING_BUFFER_MAX_BYTES = PROXY_SSE_STREAM_MAX_BYTES;
const PROXY_SSE_READ_IDLE_TIMEOUT_MS = 120_000;

type StreamingToolCall = ToolCall & {
  partialJson: string;
};

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number; contentSignature?: string }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      usage: AssistantMessage["usage"];
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      errorMessage?: string;
      usage: AssistantMessage["usage"];
    };

type ProxySerializableStreamOptions = Pick<
  SimpleStreamOptions,
  | "temperature"
  | "maxTokens"
  | "reasoning"
  | "cacheRetention"
  | "sessionId"
  | "promptCacheKey"
  | "metadata"
  | "transport"
  | "thinkingBudgets"
  | "maxRetryDelayMs"
  | "timeoutMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
  /** Local abort signal for the proxy request */
  signal?: AbortSignal;
  /** Auth token for the proxy server */
  authToken: string;
  /** Proxy server URL (e.g., "https://genai.example.com") */
  proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
  return {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    promptCacheKey: options.promptCacheKey,
    metadata: options.metadata,
    transport: options.transport,
    thinkingBudgets: options.thinkingBudgets,
    maxRetryDelayMs: options.maxRetryDelayMs,
    timeoutMs: options.timeoutMs,
  };
}

function sanitizeProxyModel(model: Model): Model {
  const { headers: _headers, ...safeModel } = model;
  return safeModel;
}

function createProxyRequestTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Proxy request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function buildProxyRequestAbort(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(createProxyRequestTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    clear: () => {
      clearTimeout(timeoutId);
    },
  };
}

async function readProxyErrorData(
  response: Response,
  readIdleTimeoutMs: number,
): Promise<{ error?: string } | undefined> {
  const bytes = await readResponseWithLimit(response, PROXY_ERROR_BODY_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`Proxy error body exceeded ${maxBytes} bytes`),
    chunkTimeoutMs: readIdleTimeoutMs,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Proxy error body stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { error?: string };
}

function assertProxySsePendingBufferWithinLimit(buffer: string): void {
  const size = new TextEncoder().encode(buffer).byteLength;
  if (size <= PROXY_SSE_PENDING_BUFFER_MAX_BYTES) {
    return;
  }
  throw new Error(`Proxy SSE pending buffer exceeded ${PROXY_SSE_PENDING_BUFFER_MAX_BYTES} bytes`);
}

export function streamProxy(
  model: Model,
  context: Context,
  options: ProxyStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: makeZeroUsageSnapshot(),
      timestamp: Date.now(),
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let readerReachedEof = false;
    let cancellation: Promise<void> | undefined;
    let cleanupReason: unknown;
    const readIdleTimeoutMs = resolvePositiveTimerTimeoutMs(
      options.timeoutMs,
      PROXY_SSE_READ_IDLE_TIMEOUT_MS,
    );
    const cancelReader = (reason?: unknown) =>
      reader ? (cancellation ??= reader.cancel(reason).catch(() => undefined)) : Promise.resolve();
    const abortHandler = () => void cancelReader("Request aborted by user");
    options.signal?.addEventListener("abort", abortHandler);

    try {
      const requestAbort = buildProxyRequestAbort(options.signal, readIdleTimeoutMs);
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: sanitizeProxyModel(model),
          context,
          options: buildProxyRequestOptions(options),
        }),
        signal: requestAbort.signal,
      })
        .catch((error: unknown) => {
          if (
            !options.signal?.aborted &&
            requestAbort.signal.aborted &&
            error instanceof Error &&
            (error.name === "AbortError" ||
              error.name === "TimeoutError" ||
              error.message === "Request was aborted")
          ) {
            throw new Error(`Proxy request timed out after ${readIdleTimeoutMs}ms`, {
              cause: error,
            });
          }
          throw error;
        })
        .finally(() => {
          requestAbort.clear();
        });

      if (!response.ok) {
        let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const errorData = await readProxyErrorData(response, readIdleTimeoutMs);
          if (errorData?.error) {
            errorMessage = `Proxy error: ${errorData.error}`;
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Proxy error body")) {
            throw error;
          }
        }
        throw new Error(errorMessage);
      }

      reader = response.body!.getReader();
      const sseReader = createSseByteGuard(reader, {
        maxBytes: PROXY_SSE_STREAM_MAX_BYTES,
        onOverflow: ({ maxBytes }) => new Error(`Proxy SSE stream exceeded ${maxBytes} bytes`),
      });
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalEventSeen = false;
      const toolArgumentPreviewSchedules = new Map<number, ToolArgumentPreviewSchedule>();

      const processSseLine = (line: string): boolean => {
        // The SSE spec makes the space after "data:" optional; accept both
        // `data:{...}` and `data: {...}`, mirroring provider-transport-fetch.
        if (!line.startsWith("data:")) {
          return false;
        }
        const data = line.slice("data:".length).trim();
        if (!data) {
          return false;
        }
        const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
        const event = processProxyEvent(proxyEvent, partial, toolArgumentPreviewSchedules);
        if (!event) {
          return false;
        }
        stream.push(event);
        return event.type === "done" || event.type === "error";
      };

      while (!terminalEventSeen) {
        const { done, value } = await withResponseBodyTimeout({
          timeoutMs: readIdleTimeoutMs,
          onTimeout: () =>
            new Error(`Proxy SSE stream stalled: no data received for ${readIdleTimeoutMs}ms`),
          cancel: cancelReader,
          read: () =>
            sseReader.read().catch((error: unknown) => {
              throw toStringifiedError(error);
            }),
        });
        if (done) {
          readerReachedEof = cancellation === undefined;
          break;
        }

        if (options.signal?.aborted) {
          throw new Error("Request aborted by user");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        assertProxySsePendingBufferWithinLimit(buffer);

        for (const line of lines) {
          terminalEventSeen = processSseLine(line);
          if (terminalEventSeen) {
            break;
          }
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }
      if (readerReachedEof) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          terminalEventSeen = processSseLine(buffer);
        }
      }
      if (!terminalEventSeen) {
        throw new Error("Proxy stream ended before terminal event");
      }

      stream.end();
    } catch (error) {
      cleanupReason = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = errorMessage;
      stream.push({
        type: "error",
        reason,
        error: partial,
      });
      stream.end();
    } finally {
      try {
        if (reader && !readerReachedEof) {
          // Upstream cancellation may never settle; it must not prevent reader release.
          void cancelReader(cleanupReason);
        }
        reader?.releaseLock();
      } catch {
        // Stream handling above already pushed the terminal proxy event;
        // cleanup failures must not replace it with a secondary release error.
      }
      options.signal?.removeEventListener("abort", abortHandler);
    }
  })();

  return stream;
}

function processProxyEvent(
  proxyEvent: ProxyAssistantMessageEvent,
  partial: AssistantMessage,
  toolArgumentPreviewSchedules: Map<number, ToolArgumentPreviewSchedule>,
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      return { type: "start", partial };

    case "text_start":
      partial.content[proxyEvent.contentIndex] = {
        type: "text",
        text: "",
        ...(proxyEvent.contentSignature !== undefined
          ? { textSignature: proxyEvent.contentSignature }
          : {}),
      };
      return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      const expectedType =
        proxyEvent.type === "text_delta"
          ? "text"
          : proxyEvent.type === "thinking_delta"
            ? "thinking"
            : "toolCall";
      if (content?.type !== expectedType) {
        throw new Error(`Received ${proxyEvent.type} for non-${expectedType} content`);
      }
      if (content.type === "text") {
        content.text += proxyEvent.delta;
      } else if (content.type === "thinking") {
        content.thinking += proxyEvent.delta;
      } else {
        const streamingContent = content as StreamingToolCall;
        streamingContent.partialJson += proxyEvent.delta;
        const previewSchedule = toolArgumentPreviewSchedules.get(proxyEvent.contentIndex);
        if (!previewSchedule) {
          throw new Error("Received toolcall_delta without a preview schedule");
        }
        if (previewSchedule(streamingContent.partialJson.length)) {
          content.arguments = parseStreamingJson(streamingContent.partialJson);
        }
        partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
      }
      return {
        type: proxyEvent.type,
        contentIndex: proxyEvent.contentIndex,
        delta: proxyEvent.delta,
        partial,
      };
    }

    case "text_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "text") {
        if (proxyEvent.contentSignature !== undefined) {
          content.textSignature = proxyEvent.contentSignature;
        }
        return {
          type: "text_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.text,
          partial,
        };
      }
      throw new Error("Received text_end for non-text content");
    }

    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

    case "thinking_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinkingSignature = proxyEvent.contentSignature;
        return {
          type: "thinking_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.thinking,
          partial,
        };
      }
      throw new Error("Received thinking_end for non-thinking content");
    }

    case "toolcall_start": {
      const content = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      } satisfies StreamingToolCall;
      partial.content[proxyEvent.contentIndex] = content;
      toolArgumentPreviewSchedules.set(
        proxyEvent.contentIndex,
        createToolArgumentPreviewSchedule(),
      );
      return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
    }

    case "toolcall_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        const streamingContent = content as StreamingToolCall;
        content.arguments = streamingContent.partialJson
          ? parseTerminalToolCallArguments(streamingContent.partialJson)
          : {};
        toolArgumentPreviewSchedules.delete(proxyEvent.contentIndex);
        delete (content as Partial<StreamingToolCall>).partialJson;
        return {
          type: "toolcall_end",
          contentIndex: proxyEvent.contentIndex,
          toolCall: content,
          partial,
        };
      }
      return undefined;
    }

    case "done":
      partial.stopReason = proxyEvent.reason;
      partial.usage = proxyEvent.usage;
      return { type: "done", reason: proxyEvent.reason, message: partial };

    case "error":
      partial.stopReason = proxyEvent.reason;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      return { type: "error", reason: proxyEvent.reason, error: partial };

    default: {
      proxyEvent satisfies never;
      console.warn(`Unhandled proxy event type: ${(proxyEvent as { type?: string }).type}`);
      return undefined;
    }
  }
}
