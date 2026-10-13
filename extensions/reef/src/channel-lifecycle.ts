import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";

const REEF_RECONCILE_INTERVAL_MS = 30_000;
const CONTINUE_AFTER_RECONCILE_ERROR = () => true;
const STOP_AFTER_RECONCILE_ERROR = () => false;

async function runReconcileStep(params: {
  reconcile: (signal: AbortSignal) => Promise<void>;
  onReconcileError: (error: unknown) => void;
  shouldContinueAfterError: (error: unknown) => boolean;
  signal: AbortSignal;
}): Promise<void> {
  try {
    await params.reconcile(params.signal);
  } catch (error) {
    if (params.signal.aborted) {
      return;
    }
    if (!params.shouldContinueAfterError(error)) {
      throw error;
    }
    params.onReconcileError(error);
  }
}

// One abort scope owns both account loops. If either branch throws, the inbox
// loop must be torn down and awaited before startAccount settles: a leaked
// loop keeps reconnecting as this handle, fights the replacement instance for
// the single relay inbox socket, and drives the relay into rate limiting.
export async function runReefChannelLifecycle(params: {
  scheduler: PluginServiceSchedulerV1;
  startInbox: (signal: AbortSignal) => Promise<void>;
  reconcile: (signal: AbortSignal) => Promise<void>;
  onReconcileError: (error: unknown) => void;
  // Startup may continue only for errors the channel classifies as retryable.
  // Periodic reconcile remains best-effort once the account is already active.
  shouldContinueAfterStartupReconcileError?: (error: unknown) => boolean;
  // Runs after the startup reconcile either refreshes peer keys or reports a
  // classified retryable failure, before the inbox can dispatch a turn.
  onReady?: () => Promise<void>;
  reconcileIntervalMs?: number;
}): Promise<void> {
  if (params.scheduler.signal.aborted) {
    return;
  }
  const lifecycle = params.scheduler.scope();
  const intervalMs = params.reconcileIntervalMs ?? REEF_RECONCILE_INTERVAL_MS;
  const reconciliationFailed = createDeferred<never>();
  // Declared outside the try so the finally can await it even when the startup
  // steps below throw before the inbox is started.
  let inboxTask: Promise<void> | undefined;
  try {
    await runReconcileStep({
      ...params,
      shouldContinueAfterError:
        params.shouldContinueAfterStartupReconcileError ?? STOP_AFTER_RECONCILE_ERROR,
      signal: lifecycle.signal,
    });
    if (lifecycle.signal.aborted) {
      return;
    }
    await params.onReady?.();
    if (lifecycle.signal.aborted) {
      return;
    }
    lifecycle.schedule({
      id: "reconcile",
      delayMs: intervalMs,
      everyMs: intervalMs,
      run: () =>
        runReconcileStep({
          ...params,
          shouldContinueAfterError: CONTINUE_AFTER_RECONCILE_ERROR,
          signal: lifecycle.signal,
        }).catch(reconciliationFailed.reject),
    });
    inboxTask = params.startInbox(lifecycle.signal);
    await Promise.race([inboxTask, reconciliationFailed.promise]);
  } finally {
    lifecycle.beginClose();
    // Neither branch may outlive the account, including a failed inbox drain.
    await Promise.allSettled([inboxTask, lifecycle.stop()]);
  }
}
