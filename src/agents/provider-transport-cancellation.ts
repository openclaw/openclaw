import { captureAsyncWorkTracker, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";

export async function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  reason?: unknown,
): Promise<void> {
  // Reader cancellation is cleanup. An upstream cancel failure must not replace
  // the wrapper's authoritative stream error or downstream cancellation.
  await reader?.cancel(reason).catch(() => undefined);
}

/** Retain error-path cleanup with the response owner without delaying its error. */
export function captureBestEffortReaderCancellation() {
  const trackCleanup = captureAsyncWorkTracker();
  return (reader: ReadableStreamDefaultReader<Uint8Array> | undefined, reason?: unknown): void => {
    let cancellation: Promise<void> | undefined;
    const start = () => (cancellation ??= cancelReaderBestEffort(reader, reason));
    // Admitted cleanup starts inside its owner so cooperating descendants join it.
    // A closed owner rejects before invoking start; only that no-start case falls
    // back outside work scopes, without restoring any captured authorization.
    void trackCleanup(start).catch(() => {
      if (cancellation === undefined) {
        void runOutsideAsyncWorkScope(start).catch(() => undefined);
      }
    });
  };
}
