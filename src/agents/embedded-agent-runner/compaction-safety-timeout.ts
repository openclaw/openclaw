import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { compactionWatchdogResets } from "../../context-engine/compaction-watchdog.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { runAbortableTimeout } from "../../node-host/with-timeout.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}

export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal: AbortSignal | undefined, resetTimeout: () => void) => Promise<T>,
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

  return await runAbortableTimeout(
    async (timeoutSignal, resetTimeout) => {
      const abortSignal = opts?.abortSignal;
      const composedAbortSignal =
        timeoutSignal && abortSignal
          ? AbortSignal.any([timeoutSignal, abortSignal])
          : (timeoutSignal ?? abortSignal);

      timeoutSignal?.addEventListener("abort", cancel, { once: true });

      try {
        return await racePromiseWithAbortSignal(
          () => trackAsyncWork(() => compact(composedAbortSignal, resetTimeout)),
          abortSignal,
          (signal) => {
            cancel();
            const reason = signal.reason;
            return reason instanceof Error
              ? reason
              : createAbortError("aborted", reason ? { cause: reason } : undefined);
          },
        );
      } finally {
        timeoutSignal?.removeEventListener("abort", cancel);
      }
    },
    timeoutMs,
    "Compaction",
  );
}

type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Every engine is bounded by one host window and receives the composed
 * timeout/caller cancellation signal. Only the built-in runtime delegate, reached
 * with that signal, refreshes the window as its native stages make progress.
 */
export function compactContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact" | "info">,
  params: ContextEngineCompactParams,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  return compactWithSafetyTimeout(
    (compactionAbortSignal, resetTimeout) => {
      if (!compactionAbortSignal) {
        return contextEngine.compact(params);
      }
      compactionWatchdogResets.set(compactionAbortSignal, resetTimeout);
      return contextEngine.compact({ ...params, abortSignal: compactionAbortSignal });
    },
    timeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}
