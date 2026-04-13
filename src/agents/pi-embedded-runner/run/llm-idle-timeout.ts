import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { DEFAULT_LLM_IDLE_TIMEOUT_SECONDS } from "../../../config/agent-timeout-defaults.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Default idle timeout for LLM streaming responses in milliseconds.
 */
export const DEFAULT_LLM_IDLE_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_SECONDS * 1000;

/**
 * Maximum safe timeout value (approximately 24.8 days).
 */
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

const clampTimeoutMs = (valueMs: number) => Math.min(Math.floor(valueMs), MAX_SAFE_TIMEOUT_MS);

export type ResolveLlmTimeoutParams = {
  cfg?: OpenClawConfig;
  trigger?: EmbeddedRunTrigger;
  runTimeoutMs?: number;
};

/**
 * Resolves the LLM idle timeout from configuration.
 *
 * Applies between tokens once streaming has started. Resolution precedence:
 *   1. `agents.defaults.llm.idleTimeoutSeconds` (0 = explicitly disabled)
 *   2. Caller-provided `runTimeoutMs`
 *   3. `agents.defaults.timeoutSeconds`
 *   4. Cron triggers default to 0 (disabled)
 *   5. {@link DEFAULT_LLM_IDLE_TIMEOUT_MS}
 *
 * @returns Idle timeout in milliseconds, or 0 to disable
 */
export function resolveLlmIdleTimeoutMs(params?: ResolveLlmTimeoutParams): number {
  const raw = params?.cfg?.agents?.defaults?.llm?.idleTimeoutSeconds;
  // 0 means explicitly disabled (no timeout).
  if (raw === 0) {
    return 0;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return clampTimeoutMs(raw * 1000);
  }

  const runTimeoutMs = params?.runTimeoutMs;
  if (typeof runTimeoutMs === "number" && Number.isFinite(runTimeoutMs) && runTimeoutMs > 0) {
    if (runTimeoutMs >= MAX_SAFE_TIMEOUT_MS) {
      return 0;
    }
    return clampTimeoutMs(runTimeoutMs);
  }

  const agentTimeoutSeconds = params?.cfg?.agents?.defaults?.timeoutSeconds;
  if (
    typeof agentTimeoutSeconds === "number" &&
    Number.isFinite(agentTimeoutSeconds) &&
    agentTimeoutSeconds > 0
  ) {
    return clampTimeoutMs(agentTimeoutSeconds * 1000);
  }

  if (params?.trigger === "cron") {
    return 0;
  }

  return DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

/**
 * Resolves the first-token timeout from configuration.
 *
 * Applies only while waiting for the very first token from the model. Useful
 * when cold model loads or upstream keepalives make the first-token wait
 * legitimately longer than mid-stream gaps.
 *
 * Resolution precedence:
 *   1. `agents.defaults.llm.firstTokenTimeoutSeconds === 0` → disabled
 *      (no first-token timer; waits indefinitely for the first chunk).
 *      The idle timer still applies after the first chunk arrives.
 *   2. positive `firstTokenTimeoutSeconds` → clamped ms.
 *   3. Unset → `undefined`, telling {@link streamWithIdleTimeout} to inherit
 *      {@link resolveLlmIdleTimeoutMs} for the first-token phase
 *      (backwards-compatible behavior).
 *
 * @returns First-token timeout in ms, `0` for disabled, or `undefined` for inherit-idle
 */
export function resolveLlmFirstTokenTimeoutMs(
  params?: ResolveLlmTimeoutParams,
): number | undefined {
  const raw = params?.cfg?.agents?.defaults?.llm?.firstTokenTimeoutSeconds;
  // Explicit disable — no first-token timer at all.
  if (raw === 0) {
    return 0;
  }
  // Explicit positive value.
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return clampTimeoutMs(raw * 1000);
  }
  // Unset or invalid → inherit idle (handled by streamWithIdleTimeout).
  return undefined;
}

/**
 * Options for {@link streamWithIdleTimeout}.
 */
export type StreamIdleTimeoutOptions = {
  /**
   * Maximum milliseconds between tokens once streaming has started.
   * Set to 0 to disable the wrapper entirely (both phases off).
   */
  idleTimeoutMs: number;
  /**
   * Maximum milliseconds to wait for the first token.
   * - `undefined`: inherit {@link idleTimeoutMs} (backwards-compatible).
   * - `0`: disable the first-token timer (wait indefinitely for the first chunk).
   *   The idle timer still takes over once the first chunk arrives.
   * - positive: dedicated first-token window. Lets callers set a tight idle
   *   timeout without killing cold model loads or warm-up gaps.
   */
  firstTokenTimeoutMs?: number;
  /**
   * Optional callback invoked when a timeout fires. Receives the error
   * that will be thrown to the stream consumer.
   */
  onIdleTimeout?: (error: Error) => void;
};

/**
 * Wraps a stream function with two-phase timeout detection.
 *
 * Phase 1 — before the first token: uses `firstTokenTimeoutMs` when set
 * (including `0` to disable), otherwise inherits `idleTimeoutMs`. This is
 * where cold-load delays live.
 *
 * Phase 2 — after the first token: always uses `idleTimeoutMs`. This catches
 * mid-stream hangs (network stalls, model crashes) quickly, since once
 * generation starts a long silence is almost certainly a real fault.
 *
 * Splitting the two means callers can set a tight idle timeout for
 * responsive fault detection without accidentally killing cold requests
 * that are still legitimately loading a model.
 *
 * If `idleTimeoutMs` is 0, the wrapper is a no-op and returns `baseFn`
 * untouched.
 *
 * @param baseFn - The base stream function to wrap
 * @param options - Timeout configuration
 * @returns A wrapped stream function with two-phase timeout detection
 */
export function streamWithIdleTimeout(
  baseFn: StreamFn,
  options: StreamIdleTimeoutOptions,
): StreamFn {
  const { idleTimeoutMs, firstTokenTimeoutMs, onIdleTimeout } = options;

  // idleTimeoutMs === 0 is the master off-switch: return the base function
  // untouched so there is zero wrapping overhead.
  if (idleTimeoutMs === 0) {
    return baseFn;
  }

  // First-token window.
  //   undefined → inherit idle (legacy behavior).
  //   0         → disabled (no timer during first-token phase).
  //   positive  → use as-is.
  const firstTokenPhaseMs: number = firstTokenTimeoutMs === undefined
    ? idleTimeoutMs
    : firstTokenTimeoutMs;

  return (model, context, streamCallOptions) => {
    const maybeStream = baseFn(model, context, streamCallOptions);

    const wrapStream = (stream: ReturnType<typeof streamSimple>) => {
      const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
      (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
        function () {
          const iterator = originalAsyncIterator();
          let idleTimer: NodeJS.Timeout | null = null;
          // Cleared to false until we receive our first non-done chunk.
          // Until then the first-token window applies; after, idle does.
          let firstTokenSeen = false;

          const currentPhase = (): { timeoutMs: number; phase: "first-token" | "idle" } => {
            return firstTokenSeen
              ? { timeoutMs: idleTimeoutMs, phase: "idle" }
              : { timeoutMs: firstTokenPhaseMs, phase: "first-token" };
          };

          const createTimeoutPromise = (timeoutMs: number, phase: string): Promise<never> => {
            return new Promise((_, reject) => {
              idleTimer = setTimeout(() => {
                const error = new Error(
                  `LLM ${phase} timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`,
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
                const { timeoutMs, phase } = currentPhase();
                // Race only when the current phase actually has a timer.
                // timeoutMs === 0 means this phase is disabled (wait forever).
                const result =
                  timeoutMs === 0
                    ? await iterator.next()
                    : await Promise.race([iterator.next(), createTimeoutPromise(timeoutMs, phase)]);

                if (result.done) {
                  clearTimer();
                  return result;
                }

                clearTimer();
                // Received a real chunk — future gaps are "idle", not first-token.
                firstTokenSeen = true;
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
