import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
/** Thread context for active runs - used to prevent cross-thread steering. */
const ACTIVE_RUN_THREAD_CONTEXT = new Map<string, string | number | undefined>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  diag.debug(`aborting run: sessionId=${sessionId}`);
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}

/**
 * Check if thread context is registered for a session.
 * Returns true only if the session is active AND thread context has been set.
 * Cleans up stale entries if the run is no longer active.
 *
 * Note: setActiveEmbeddedRun() always sets thread context (even if undefined),
 * so this returning true means we know the thread (undefined = unthreaded/DM).
 * This returning false means either the run isn't active, or setActiveEmbeddedRun()
 * wasn't called (shouldn't happen, but we're conservative).
 */
export function hasActiveRunThreadContext(sessionId: string): boolean {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    // Run is not active - clean up any stale thread context
    if (ACTIVE_RUN_THREAD_CONTEXT.has(sessionId)) {
      ACTIVE_RUN_THREAD_CONTEXT.delete(sessionId);
      diag.debug(`cleaned stale thread context: sessionId=${sessionId}`);
    }
    return false;
  }
  return ACTIVE_RUN_THREAD_CONTEXT.has(sessionId);
}

/**
 * Get the thread context for an active run.
 * Used to prevent cross-thread steering - only steer if thread IDs match.
 *
 * Returns undefined for both "unthreaded/DM" and "not registered".
 * Use hasActiveRunThreadContext() first to distinguish these cases.
 */
export function getActiveRunThreadContext(sessionId: string): string | number | undefined {
  // Only return context if run is active (hasActiveRunThreadContext handles cleanup)
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return undefined;
  }
  return ACTIVE_RUN_THREAD_CONTEXT.get(sessionId);
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  threadContext?: string | number,
) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  // Always store thread context (even undefined) to distinguish "no thread" from "not registered"
  ACTIVE_RUN_THREAD_CONTEXT.set(sessionId, threadContext);
  logSessionStateChange({
    sessionId,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    ACTIVE_RUN_THREAD_CONTEXT.delete(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    // Handle mismatch is expected when a run was replaced (see "run_replaced" in setActiveEmbeddedRun).
    // Thread context is keyed by sessionId, not handle, so it persists with the replacement run.
    diag.debug(
      `run clear skipped: sessionId=${sessionId} reason=handle_mismatch (run was likely replaced)`,
    );
  }
}

export type { EmbeddedPiQueueHandle };
