/**
 * Wraps compaction calls with a safety timeout and abort cleanup.
 */
import {
  finiteSecondsToTimerSafeMilliseconds,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

function createAbortError(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => {} };
  }

  const controller = new AbortController();
  const removers: Array<() => void> = [];

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort("reason" in signal ? signal.reason : undefined);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const onAbort = () => abortFrom(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) {
        remove();
      }
    },
  };
}

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}

export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal?: AbortSignal) => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
  },
): Promise<T> {
  let canceled = false;
  const cancel = () => {
    if (canceled) {
      return;
    }
    canceled = true;
    try {
      opts?.onCancel?.();
    } catch {
      // Best-effort cancellation hook. Keep the timeout/abort path intact even
      // if the underlying compaction cancel operation throws.
    }
  };

  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const timeoutController = resolvedTimeoutMs ? new AbortController() : undefined;
  const abortSignal = opts?.abortSignal;
  const composedAbortSignal = composeAbortSignals(timeoutController?.signal, abortSignal);
  let timeout: NodeJS.Timeout | undefined;
  let externalAbortListener: (() => void) | undefined;

  try {
    if (abortSignal?.aborted) {
      cancel();
      throw createAbortError(abortSignal);
    }

    const compactPromise = compact(composedAbortSignal.signal);
    const contenders: Array<Promise<T> | Promise<never>> = [compactPromise];

    if (resolvedTimeoutMs && timeoutController) {
      const timeoutError = new Error("Compaction timed out");
      contenders.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timeoutController.abort(timeoutError);
            cancel();
            queueMicrotask(() => reject(timeoutError));
          }, resolvedTimeoutMs);
          timeout.unref?.();
        }),
      );
    }

    if (abortSignal) {
      contenders.push(
        new Promise<never>((_, reject) => {
          externalAbortListener = () => {
            cancel();
            reject(createAbortError(abortSignal));
          };
          abortSignal.addEventListener("abort", externalAbortListener, { once: true });
        }),
      );
    }

    return await Promise.race(contenders);
  } finally {
    composedAbortSignal.cleanup();
    if (timeout) {
      clearTimeout(timeout);
    }
    if (externalAbortListener) {
      abortSignal?.removeEventListener("abort", externalAbortListener);
    }
  }
}

/** Parameters for a single {@link ContextEngine.compact} invocation. */
type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Invoke a plugin-owned {@link ContextEngine.compact} bounded by the same
 * finite safety timeout that protects native runtime compaction.
 *
 * Plugin context engines that advertise `ownsCompaction` previously had their
 * `compact()` awaited with no timeout, no watchdog, and no abort signal — a
 * slow or hung plugin compaction would hang the agent turn indefinitely. This
 * wrapper closes that gap:
 *  - the call is bounded by `timeoutMs` (host-resolved, default
 *    {@link EMBEDDED_COMPACTION_TIMEOUT_MS}); on timeout it rejects with a
 *    "Compaction timed out" error so the caller's existing failure handling
 *    runs instead of hanging;
 *  - the timeout signal and caller `abortSignal` are both raced against the
 *    call (so a non-cooperating engine is still bounded) and threaded into the
 *    `compact()` params (so cooperating engines can cancel their own in-flight
 *    work).
 *
 * Callers keep their existing try/catch — a timeout or abort surfaces as a
 * thrown error, never a silent hang.
 */
export function compactContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact">,
  params: ContextEngineCompactParams,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  return compactWithSafetyTimeout(
    (compactAbortSignal) =>
      contextEngine.compact(
        compactAbortSignal ? { ...params, abortSignal: compactAbortSignal } : params,
      ),
    timeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}
