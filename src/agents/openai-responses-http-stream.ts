/**
 * OpenAI Responses HTTP SSE StreamFn
 *
 * Implements the OpenAI Responses API (`/v1/responses`) over HTTP with
 * Server-Sent Events (SSE) for streaming. This is the HTTP counterpart to
 * `openai-ws-stream.ts` (which uses WebSocket transport) and is intended
 * for custom providers that expose an OpenAI Responses-compatible endpoint.
 *
 * Key behaviors:
 *  - POST to `{baseUrl}/v1/responses` with `stream: true`
 *  - Parse SSE events: `response.output_text.delta`, `response.completed`,
 *    `response.failed`, etc.
 *  - Reuse converters from `openai-ws-stream.ts` for message/tool conversion
 *  - Build final AssistantMessage via `buildAssistantMessageFromResponse()`
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ResponseObject } from "./openai-ws-connection.js";
import {
  convertMessagesToInputItems,
  convertTools,
  buildAssistantMessageFromResponse,
} from "./openai-ws-stream.js";
import { log } from "./pi-embedded-runner/logger.js";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// SSE line parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 * Yields parsed JSON objects for each `data:` line (skipping `[DONE]`).
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            continue;
          }
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // Skip malformed JSON lines
            log.debug(`[responses-http] skipping malformed SSE data: ${payload.slice(0, 120)}`);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamFn factory
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIResponsesHttpStreamOptions {
  /** API key for Authorization header. */
  apiKey: string;
  /** Base URL of the provider (e.g. "https://api.example.com/v1"). */
  baseUrl: string;
  /** Additional headers to send with the request. */
  extraHeaders?: Record<string, string>;
  /** Abort signal forwarded from the run. */
  signal?: AbortSignal;
}

/**
 * Creates a `StreamFn` that calls the OpenAI Responses API over HTTP SSE.
 *
 * Unlike the WebSocket variant, this creates a fresh HTTP request per turn
 * (no persistent connection / `previous_response_id` tracking). Full message
 * context is sent each time.
 */
export function createOpenAIResponsesHttpStreamFn(
  opts: OpenAIResponsesHttpStreamOptions,
): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();

    const run = async () => {
      // ── 1. Build request payload ─────────────────────────────────────────
      const inputItems = convertMessagesToInputItems(context.messages, model);
      const tools = convertTools(context.tools);

      // Forward generation options
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
      if (
        (streamOpts as Record<string, unknown> | undefined)?.reasoningEffort ||
        (streamOpts as Record<string, unknown> | undefined)?.reasoningSummary
      ) {
        const reasoning: { effort?: string; summary?: string } = {};
        if ((streamOpts as Record<string, unknown>).reasoningEffort !== undefined) {
          reasoning.effort = (streamOpts as Record<string, unknown>).reasoningEffort as string;
        }
        if ((streamOpts as Record<string, unknown>).reasoningSummary !== undefined) {
          reasoning.summary = (streamOpts as Record<string, unknown>).reasoningSummary as string;
        }
        extraParams.reasoning = reasoning;
      }

      // Respect compat.supportsStore
      const supportsStore = (model as { compat?: { supportsStore?: boolean } }).compat
        ?.supportsStore;

      const payload: Record<string, unknown> = {
        model: model.id,
        ...(supportsStore !== false ? { store: false } : {}),
        input: inputItems,
        instructions: context.systemPrompt ?? undefined,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        ...extraParams,
      };
      const nextPayload = await options?.onPayload?.(payload, model);
      const requestPayload = nextPayload ?? payload;

      // ── 2. Build URL and headers ─────────────────────────────────────────
      const baseUrl = (opts.baseUrl || (model as { baseUrl?: string }).baseUrl || "").replace(
        /\/+$/,
        "",
      );
      const responsesUrl = `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/responses`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.extraHeaders ?? {}),
      };

      log.debug(
        `[responses-http] POST ${responsesUrl} (${inputItems.length} input items, ${tools.length} tools)`,
      );

      // ── 3. Make the request ──────────────────────────────────────────────
      const signal = opts.signal ?? (options as { signal?: AbortSignal } | undefined)?.signal;

      const response = await fetch(responsesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `OpenAI Responses HTTP error ${response.status}: ${errorBody.slice(0, 500)}`,
        );
      }

      if (!response.body) {
        throw new Error("OpenAI Responses HTTP: response body is null");
      }

      // ── 4. Emit start event ──────────────────────────────────────────────
      eventStream.push({
        type: "start",
        partial: buildAssistantMessageWithZeroUsage({
          model,
          content: [],
          stopReason: "stop",
        }),
      });

      // ── 5. Parse SSE events ──────────────────────────────────────────────
      for await (const event of parseSseStream(response.body, signal)) {
        const eventType = event.type as string;

        if (eventType === "response.output_text.delta") {
          const delta = (event as { delta?: string }).delta ?? "";
          if (delta) {
            const partialMsg: AssistantMessage = buildAssistantMessageWithZeroUsage({
              model,
              content: [{ type: "text", text: delta }],
              stopReason: "stop",
            });
            eventStream.push({
              type: "text_delta",
              contentIndex: 0,
              delta,
              partial: partialMsg,
            });
          }
        } else if (eventType === "response.completed") {
          const responseObj = (event as { response?: ResponseObject }).response;
          if (responseObj) {
            const assistantMsg = buildAssistantMessageFromResponse(responseObj, {
              api: model.api,
              provider: model.provider,
              id: model.id,
            });
            const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
              assistantMsg.stopReason === "toolUse" ? "toolUse" : "stop";
            eventStream.push({ type: "done", reason, message: assistantMsg });
          }
        } else if (eventType === "response.failed") {
          const responseObj = (event as { response?: ResponseObject }).response;
          const errMsg = responseObj?.error?.message ?? "Response failed";
          throw new Error(`OpenAI Responses HTTP: ${errMsg}`);
        } else if (eventType === "error") {
          const errEvent = event as { message?: string; code?: string };
          throw new Error(
            `OpenAI Responses HTTP error: ${errEvent.message ?? "unknown"} (code=${errEvent.code ?? "?"})`,
          );
        }
        // Other events (response.created, response.in_progress, rate_limits.updated, etc.)
        // are informational — skip silently.
      }

      // End the stream after all SSE events have been processed.
      eventStream.end();
    };

    queueMicrotask(() =>
      run().catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[responses-http] run error: ${errorMessage}`);
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
