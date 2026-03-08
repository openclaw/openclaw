/**
 * Waits for an AbortSignal to fire (i.e. resolves when the signal is aborted).
 *
 * This is used by the IRC channel plugin's `startAccount` implementation to
 * keep the returned promise alive until the gateway signals shutdown.
 * Without it, `startAccount` returns immediately, which the gateway interprets
 * as "stopped" and schedules an auto-restart — creating a second IRC connection
 * with the same nick and triggering 433 "Nickname already in use" errors.
 *
 * Edge cases:
 * - If the signal is already aborted, resolves immediately.
 * - If no signal is provided (undefined), resolves immediately (backward-compat).
 */
export function waitForAbortSignal(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
