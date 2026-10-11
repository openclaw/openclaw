// Combine active-run views without making either lifecycle owner depend on its consumers.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  getActiveReplyRunCount,
  isReplyRunActiveForSessionId,
  listActiveReplyRunSessionKeys,
  listActiveReplyRunSessionIds,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.registry.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  EMBEDDED_RUN_WAITERS,
  type EmbeddedAgentQueueHandle,
  type EmbeddedRunWaiter,
} from "./run-state.js";

export function isEmbeddedAgentRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

/** Counts active embedded runs while including auto-reply registry runs for shared sessions. */
export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

function sortedSessionIdentifiers(identifiers: Iterable<string>): string[] {
  return [...new Set(identifiers)].toSorted((a, b) => a.localeCompare(b));
}

/** Lists active embedded-run session keys from both embedded and auto-reply registries. */
export function listActiveEmbeddedRunSessionKeys(options?: {
  includeReplyRuns?: boolean;
}): string[] {
  return sortedSessionIdentifiers([
    ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(),
    ...(options?.includeReplyRuns === false ? [] : listActiveReplyRunSessionKeys()),
  ]);
}

/** Lists active embedded-run session ids from all embedded-run lookup maps. */
export function listActiveEmbeddedRunSessionIds(): string[] {
  return sortedSessionIdentifiers([
    ...ACTIVE_EMBEDDED_RUNS.keys(),
    ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
    ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.values(),
    ...listActiveReplyRunSessionIds(),
  ]);
}

/** Resolves the current session id for an active run after resets or compaction. */
export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return (
    resolveActiveReplyRunSessionId(normalizedSessionKey) ??
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
  );
}

export function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle?: EmbeddedAgentQueueHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  const isHandleActive = () =>
    handle ? ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle : ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (!isHandleActive()) {
    return handle ? Promise.resolve(true) : waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  }
  const timeoutLabel = timeoutMs === null ? "none" : String(timeoutMs);
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutLabel}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    let settled = false;
    const finish = (ended: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      waiters.delete(waiter);
      if (waiters.size === 0 && EMBEDDED_RUN_WAITERS.get(sessionId) === waiters) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(ended);
    };
    const onAbort = () => finish(false);
    const waiter: EmbeddedRunWaiter = { resolve: finish, handle };
    if (timeoutMs !== null) {
      waiter.timer = setTimeout(
        () => {
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          finish(false);
        },
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    } else if (!isHandleActive()) {
      finish(true);
    }
  });
}

export async function waitForEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
  while (isEmbeddedAgentRunActive(sessionId)) {
    const remainingMs = deadline === undefined ? null : deadline - Date.now();
    if (
      (remainingMs !== null && remainingMs <= 0) ||
      !(await waitForCurrentEmbeddedAgentRunEnd(sessionId, remainingMs))
    ) {
      return false;
    }
  }
  return true;
}

export function notifyEmbeddedRunEnded(
  sessionId: string,
  endedHandle: EmbeddedAgentQueueHandle,
  aborted = false,
) {
  notifyGatewayWorkMetricsChanged();
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  const sessionIdle = !ACTIVE_EMBEDDED_RUNS.has(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    if (aborted && !waiter.settleOnAbort) {
      continue;
    }
    if (waiter.handle ? waiter.handle !== endedHandle : !sessionIdle) {
      continue;
    }
    waiters.delete(waiter);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(true);
  }
  if (waiters.size === 0) {
    EMBEDDED_RUN_WAITERS.delete(sessionId);
  }
}
