import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { TestContext } from "vitest";

export function createTestLifetime(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  cleanup: () => Promise<void>,
) {
  const canceled = createDeferred<never>();
  // Cancellation can precede the next wait while an update is being admitted.
  void canceled.promise.catch(() => {});
  let cleanupTask: Promise<void> | undefined;
  const close = () =>
    (cleanupTask ??= Promise.resolve()
      .then(cleanup)
      .finally(() => signal.removeEventListener("abort", onAbort)));
  const onAbort = () => {
    canceled.reject(signal.reason);
    // Vitest rejects its wrapper on timeout without unwinding the test body.
    // Start release/join now; onTestFinished still observes any cleanup failure.
    void close().catch(() => {});
  };
  onTestFinished(close);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return {
    wait: <T>(promise: Promise<T>) => Promise.race([promise, canceled.promise]),
    close,
  };
}
