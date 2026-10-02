import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { compactionWatchdogResets } from "../../context-engine/compaction-watchdog.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { runAbortableTimeout } from "../../node-host/with-timeout.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError("aborted", reason ? { cause: reason } : undefined);
}

async function raceCompactionWithAbortSignal<T>(
  compact: () => Promise<T>,
  abortSignal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!abortSignal) {
    return await compact();
  }
  if (abortSignal.aborted) {
    onAbort?.();
    throw abortErrorFromSignal(abortSignal);
  }
  let abortListener!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      onAbort?.();
      reject(abortErrorFromSignal(abortSignal));
    };
    abortSignal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([compact(), abortPromise]);
  } finally {
    abortSignal.removeEventListener("abort", abortListener);
  }
}

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
        return await raceCompactionWithAbortSignal(
          () => trackAsyncWork(() => compact(composedAbortSignal, resetTimeout)),
          abortSignal,
          cancel,
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
