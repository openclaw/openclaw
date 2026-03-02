import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { retryAsync } from "../../../infra/retry.js";
import { isRateLimitErrorMessage, isTransientHttpError } from "./errors.js";

/**
 * Wraps a StreamFn with retry logic for transient errors (rate limits, 5xx).
 * This only retries if the error happens before any content is yielded.
 */
export function wrapStreamFnWithRetry(inner: StreamFn): StreamFn {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await retryAsync(
          async () => {
            let started = false;
            const stream = inner(model, context, options);

            for await (const event of stream) {
              if (event.type === "error") {
                const msg = event.error?.errorMessage || "";
                if (!started && (isRateLimitErrorMessage(msg) || isTransientHttpError(msg))) {
                  // Throwing here triggers retryAsync
                  throw new Error(msg);
                }
              }

              if (
                event.type === "content" ||
                event.type === "reasoning" ||
                event.type === "tool_call"
              ) {
                started = true;
              }

              out.push(event);
            }
          },
          {
            attempts: 3,
            minDelayMs: 1000,
            maxDelayMs: 10000,
            jitter: 0.1,
            shouldRetry: (err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              return isRateLimitErrorMessage(msg) || isTransientHttpError(msg);
            },
          },
        );
      } catch {
        // Final failure after retries
        // The last error event was already pushed to 'out' in the loop above
        // unless the loop itself failed to even start.
      } finally {
        out.end();
      }
    };

    queueMicrotask(() => void run());
    return out;
  };
}
