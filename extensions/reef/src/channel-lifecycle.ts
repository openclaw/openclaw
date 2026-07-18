import { abortableSleep } from "./transport.js";

const REEF_RECONCILE_INTERVAL_MS = 30_000;

// One abort scope owns both account loops. If either branch throws, the inbox
// loop must be torn down and awaited before startAccount settles: a leaked
// loop keeps reconnecting as this handle, fights the replacement instance for
// the single relay inbox socket, and drives the relay into rate limiting.
export async function runReefChannelLifecycle(params: {
  parentSignal: AbortSignal;
  startInbox: (signal: AbortSignal) => Promise<void>;
  reconcile: () => Promise<void>;
  onReconcileError: (error: unknown) => void;
  reconcileIntervalMs?: number;
}): Promise<void> {
  const lifecycle = new AbortController();
  const onParentAbort = () => lifecycle.abort();
  params.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (params.parentSignal.aborted) {
    // Listeners added after an abort never fire; inherit the abort directly.
    lifecycle.abort();
  }
  const intervalMs = params.reconcileIntervalMs ?? REEF_RECONCILE_INTERVAL_MS;
  const reconciliationLoop = async () => {
    while (!lifecycle.signal.aborted) {
      await abortableSleep(intervalMs, lifecycle.signal);
      if (lifecycle.signal.aborted) {
        return;
      }
      try {
        await params.reconcile();
      } catch (error) {
        // Transient relay failures (429, network) must not crash the channel:
        // the crash-restart cycle re-registers the inbox connection and is
        // itself what escalates relay rate limiting.
        params.onReconcileError(error);
      }
    }
  };
  const inboxTask = params.startInbox(lifecycle.signal);
  try {
    await Promise.all([inboxTask, reconciliationLoop()]);
  } finally {
    lifecycle.abort();
    params.parentSignal.removeEventListener("abort", onParentAbort);
    // startInbox resolves (never rejects) once its socket work is quiescent,
    // so no reconnect loop can outlive this account instance.
    await inboxTask;
  }
}
