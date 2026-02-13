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
  /** Optional callback when compaction completes - used to flush pending messages */
  onCompactionComplete?: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

/** Messages queued while session is compacting - will be processed after compaction completes */
const PENDING_COMPACTION_MESSAGES = new Map<string, string[]>();
const MAX_PENDING_MESSAGES = 10; // Limit to prevent unbounded growth

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
    // Queue message for processing after compaction instead of dropping it
    const pending = PENDING_COMPACTION_MESSAGES.get(sessionId) ?? [];
    if (pending.length < MAX_PENDING_MESSAGES) {
      pending.push(text);
      PENDING_COMPACTION_MESSAGES.set(sessionId, pending);
      diag.debug(
        `message queued for post-compaction: sessionId=${sessionId} pendingCount=${pending.length}`,
      );
      logMessageQueued({ sessionId, source: "pi-embedded-runner-pending" });
      return true; // Message accepted, will be processed later
    } else {
      diag.warn(`pending compaction queue full: sessionId=${sessionId} dropped message`);
      return false;
    }
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}

/** Process any messages that were queued during compaction */
export function flushPendingCompactionMessages(sessionId: string): void {
  const pending = PENDING_COMPACTION_MESSAGES.get(sessionId);
  if (!pending || pending.length === 0) {
    return;
  }

  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(
      `flush pending failed: sessionId=${sessionId} reason=no_active_run pendingCount=${pending.length}`,
    );
    // Keep messages queued - they may be deliverable on a future attempt
    return;
  }
  if (!handle.isStreaming()) {
    diag.debug(
      `flush pending failed: sessionId=${sessionId} reason=not_streaming pendingCount=${pending.length}`,
    );
    // Keep messages queued - session may resume streaming
    return;
  }
  if (handle.isCompacting()) {
    diag.debug(
      `flush pending deferred: sessionId=${sessionId} reason=still_compacting pendingCount=${pending.length}`,
    );
    // Keep messages queued - still compacting
    return;
  }

  // All checks passed - safe to deliver and delete
  PENDING_COMPACTION_MESSAGES.delete(sessionId);
  diag.debug(`flushing pending messages: sessionId=${sessionId} count=${pending.length}`);

  // Combine all pending messages into one to avoid multiple agent turns
  const combinedText =
    pending.length === 1
      ? pending[0]
      : `[Queued messages while agent was compacting]\n\n${pending.map((msg, i) => `---\nQueued #${i + 1}\n${msg}`).join("\n\n")}`;

  logMessageQueued({ sessionId, source: "pi-embedded-runner-flush" });
  void handle.queueMessage(combinedText);
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

export function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
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
    // Clear any pending messages for this session
    PENDING_COMPACTION_MESSAGES.delete(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export type { EmbeddedPiQueueHandle };
