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

type EmbeddedPiRunMeta = {
  runId?: string;
  startedAt: number;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
const ACTIVE_EMBEDDED_RUN_META = new Map<string, EmbeddedPiRunMeta>();
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

export function getActiveEmbeddedPiRunMeta(sessionId: string): EmbeddedPiRunMeta | undefined {
  const meta = ACTIVE_EMBEDDED_RUN_META.get(sessionId);
  return meta ? { ...meta } : undefined;
}

export function releaseEmbeddedPiRunLockOnTimeout(
  sessionId: string,
  timeoutMs: number,
): { released: boolean; runId?: string; ageMs?: number } {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const meta = ACTIVE_EMBEDDED_RUN_META.get(sessionId);
  if (!handle || !meta) {
    return { released: false };
  }
  const ageMs = Date.now() - meta.startedAt;
  if (ageMs <= timeoutMs) {
    return { released: false, runId: meta.runId, ageMs };
  }
  diag.warn(
    `single-flight timeout release: sessionId=${sessionId} reasonCode=RUN_LOCK_TIMEOUT_RELEASE runId=${meta.runId ?? "unknown"} ageMs=${ageMs}`,
  );
  handle.abort();
  ACTIVE_EMBEDDED_RUNS.delete(sessionId);
  ACTIVE_EMBEDDED_RUN_META.delete(sessionId);
  logSessionStateChange({ sessionId, state: "idle", reason: "run_lock_timeout_release" });
  notifyEmbeddedRunEnded(sessionId);
  return { released: true, runId: meta.runId, ageMs };
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
  meta?: { runId?: string },
) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  ACTIVE_EMBEDDED_RUN_META.set(sessionId, {
    runId: meta?.runId,
    startedAt: Date.now(),
  });
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
    ACTIVE_EMBEDDED_RUN_META.delete(sessionId);
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
