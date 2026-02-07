import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { isGoogleModelApi } from "../pi-embedded-helpers/google.js";
import { log } from "./logger.js";

/**
 * Wrap a StreamFn to buffer the full model response before replaying events downstream.
 *
 * Converts real streaming into "fake streaming": the HTTP request runs to completion
 * first (all SSE events are collected), then events are replayed to downstream
 * consumers. This avoids Gemini CLI OAuth streams being interrupted mid-flight
 * while downstream is busy processing.
 *
 * Only applies to Google model APIs (google-gemini-cli, google-generative-ai,
 * google-antigravity). Non-Google models pass through to the underlying streamFn
 * unchanged.
 */
export function wrapStreamFnWithBuffer(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    if (!isGoogleModelApi(model.api)) {
      return streamFn(model, context, options);
    }

    log.debug(`buffering stream for ${model.provider}/${model.id}`);

    // Create a new stream for downstream; events are replayed after the real stream finishes.
    const bufferedStream = createAssistantMessageEventStream();

    void (async () => {
      try {
        const realStream = await Promise.resolve(streamFn(model, context, options));
        const events: AssistantMessageEvent[] = [];

        // Consume the entire real stream first — HTTP connection stays open
        // until the model finishes, but downstream doesn't see any events yet.
        for await (const event of realStream) {
          events.push(event);
        }

        log.debug(`buffered ${events.length} events for ${model.id}, replaying`);

        // Replay all collected events to downstream.
        for (const event of events) {
          bufferedStream.push(event);
        }
        bufferedStream.end();
      } catch (error) {
        // The real stream should always terminate with a done/error event,
        // but if something truly unexpected happens, propagate as an error event.
        log.warn(
          `buffered stream error for ${model.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        bufferedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
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
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        });
        bufferedStream.end();
      }
    })();

    return bufferedStream;
  };
}
