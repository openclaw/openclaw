/**
 * Wraps compaction calls with a safety timeout and abort cleanup.
 */
import {
  finiteSecondsToTimerSafeMilliseconds,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  CompactionSafetyTimeoutError,
  expireCompactionTimeoutResultAcceptance,
} from "../compaction-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;
// Only cooperative typed partial results may settle here. Closing the reason-owned
// acceptance token prevents the underlying AgentSession from committing after rejection.
const COMPACTION_TIMEOUT_SETTLE_GRACE_MS = 10_000;

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError("aborted", reason ? { cause: reason } : undefined);
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
    onCancel?: (reason?: unknown) => void;
    acceptResultAfterTimeout?: (result: T) => boolean;
    timeoutResultGraceMs?: number;
  },
): Promise<T> {
  let canceled = false;
  const cancel = (reason?: unknown) => {
    if (canceled) {
      return;
    }
    canceled = true;
    try {
      opts?.onCancel?.(reason);
    } catch {
      // Best-effort cancellation hook. Keep the timeout/abort path intact even
      // if the underlying compaction cancel operation throws.
    }
  };

  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const timeoutController = resolvedTimeoutMs ? new AbortController() : undefined;
  const abortSignal = opts?.abortSignal;
  const composedAbortSignal =
    timeoutController && abortSignal
      ? AbortSignal.any([timeoutController.signal, abortSignal])
      : (timeoutController?.signal ?? abortSignal);
  const timeoutResultGraceMs = resolveTimerTimeoutMs(
    opts?.timeoutResultGraceMs ?? COMPACTION_TIMEOUT_SETTLE_GRACE_MS,
    1,
  );

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timeoutError: CompactionSafetyTimeoutError | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let timeoutResultGrace: NodeJS.Timeout | undefined;
    let externalAbortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timeoutResultGrace) {
        clearTimeout(timeoutResultGrace);
      }
      if (externalAbortListener) {
        abortSignal?.removeEventListener("abort", externalAbortListener);
      }
    };
    const resolveOnce = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      expireCompactionTimeoutResultAcceptance(timeoutError);
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      expireCompactionTimeoutResultAcceptance(timeoutError);
      cleanup();
      reject(reason);
    };

    if (abortSignal?.aborted) {
      const abortError = abortErrorFromSignal(abortSignal);
      cancel(abortError);
      rejectOnce(abortError);
      return;
    }

    if (abortSignal) {
      externalAbortListener = () => {
        const abortError = abortErrorFromSignal(abortSignal);
        cancel(abortError);
        rejectOnce(abortError);
      };
      abortSignal.addEventListener("abort", externalAbortListener, { once: true });
    }

    let compactPromise: Promise<T>;
    try {
      compactPromise = compact(composedAbortSignal);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    compactPromise.then(
      (result) => {
        if (!timedOut || opts?.acceptResultAfterTimeout?.(result)) {
          resolveOnce(result);
          return;
        }
        rejectOnce(timeoutError);
      },
      (error: unknown) => {
        rejectOnce(timedOut ? timeoutError : error);
      },
    );

    if (resolvedTimeoutMs && timeoutController) {
      timeout = setTimeout(() => {
        timedOut = true;
        timeoutError = new CompactionSafetyTimeoutError();
        timeoutController.abort(timeoutError);
        cancel(timeoutError);
        if (!opts?.acceptResultAfterTimeout || !timeoutResultGraceMs) {
          rejectOnce(timeoutError);
          return;
        }
        timeoutResultGrace = setTimeout(() => rejectOnce(timeoutError), timeoutResultGraceMs);
        timeoutResultGrace.unref?.();
      }, resolvedTimeoutMs);
      timeout.unref?.();
    }
  });
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
