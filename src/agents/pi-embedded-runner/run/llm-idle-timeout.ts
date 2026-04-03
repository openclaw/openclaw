import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/config.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Default idle timeout for LLM streaming responses in milliseconds.
 * If no token is received within this time, the request is aborted.
 * Set to 0 to disable (never timeout).
 * Default: 60 seconds.
 */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Maximum safe timeout value (approximately 24.8 days).
 */
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

/**
 * Resolves the LLM idle timeout from configuration.
 * Cron-triggered runs default to no idle timeout because long quiet periods
 * are normal for scheduled background work. An explicit config override still
 * wins for every trigger, including cron.
 * @returns Idle timeout in milliseconds, or 0 to disable
 */
export function resolveLlmIdleTimeoutMs(params: {
  cfg?: OpenClawConfig;
  trigger?: EmbeddedRunTrigger;
}): number {
  const raw = params.cfg?.agents?.defaults?.llm?.idleTimeoutSeconds;
  // 0 means disabled (no timeout)
  if (raw === 0) {
    return 0;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw) * 1000, MAX_SAFE_TIMEOUT_MS);
  }
  if (params.trigger === "cron") {
    return 0;
  }
  return DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

/**
 * Wraps a stream function with idle timeout detection.
 * If no token is received within the specified timeout, the request is aborted.
 *
 * @param baseFn - The base stream function to wrap
 * @param timeoutMs - Idle timeout in milliseconds
 * @param onIdleTimeout - Optional callback invoked when idle timeout triggers
 * @returns A wrapped stream function with idle timeout detection
 */
export function streamWithIdleTimeout(
  baseFn: StreamFn,
  timeoutMs: number,
  onIdleTimeout?: (error: Error) => void,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);

    const wrapStream = (stream: ReturnType<typeof streamSimple>) => {
      const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
      (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
        function () {
          const iterator = originalAsyncIterator();
          let idleTimer: NodeJS.Timeout | null = null;

          const createTimeoutPromise = (): Promise<never> => {
            return new Promise((_, reject) => {
              idleTimer = setTimeout(() => {
                const error = new Error(
                  `LLM idle timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`,
                );
                onIdleTimeout?.(error);
                reject(error);
              }, timeoutMs);
            });
          };

          const clearTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          };

          return {
            async next() {
              clearTimer();

              try {
                // Race between the actual next() and the timeout
                const result = await Promise.race([iterator.next(), createTimeoutPromise()]);

                if (result.done) {
                  clearTimer();
                  return result;
                }

                clearTimer();
                return result;
              } catch (error) {
                clearTimer();
                throw error;
              }
            },

            return() {
              clearTimer();
              return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined });
            },

            throw(error?: unknown) {
              clearTimer();
              return iterator.throw?.(error) ?? Promise.reject(error);
            },
          };
        };

      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then(wrapStream);
    }
    return wrapStream(maybeStream);
  };
}
