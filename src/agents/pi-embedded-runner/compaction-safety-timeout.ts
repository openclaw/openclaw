import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;

export async function compactWithSafetyTimeout<T>(
  compact: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  let cleanupMerge: (() => void) | undefined;
  try {
    return await withTimeout(
      (signal) => {
        // Merge the timeout-internal signal with an external abort signal
        // so that callers (e.g. run-level abort) can cancel compaction immediately.
        const { merged, cleanup } = mergeAbortSignals(signal, externalSignal);
        cleanupMerge = cleanup;
        return compact(merged);
      },
      timeoutMs,
      "Compaction",
    );
  } finally {
    cleanupMerge?.();
  }
}

function mergeAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { merged: AbortSignal | undefined; cleanup: () => void } {
  const noop = () => {};
  if (!a && !b) {
    return { merged: undefined, cleanup: noop };
  }
  if (!a) {
    return { merged: b, cleanup: noop };
  }
  if (!b) {
    return { merged: a, cleanup: noop };
  }
  // If either is already aborted, return that one immediately
  if (a.aborted) {
    return { merged: a, cleanup: noop };
  }
  if (b.aborted) {
    return { merged: b, cleanup: noop };
  }
  const ctrl = new AbortController();
  const onAbort = () => {
    ctrl.abort(a.aborted ? a.reason : b.reason);
    cleanup();
  };
  const cleanup = () => {
    a.removeEventListener("abort", onAbort);
    b.removeEventListener("abort", onAbort);
  };
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return { merged: ctrl.signal, cleanup };
}
