/**
 * ENGN-5611: Session TTL cleanup for completed/aborted subagents.
 *
 * Enhances the existing sweeper with:
 * - Explicit TTL for completed sessions (separate from archive)
 * - Zombie detection (sessions with no activity)
 * - Manual cleanup trigger
 * - Metric logging of active vs zombie counts
 */

import { defaultRuntime } from "../runtime.js";

export type SessionTtlConfig = {
  completedTtlMs: number;
  zombieInactivityMs: number;
  cleanupIntervalMs: number;
};

const DEFAULT_COMPLETED_TTL_MS = 30 * 60_000; // 30 minutes
const DEFAULT_ZOMBIE_INACTIVITY_MS = 15 * 60_000; // 15 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

let config: SessionTtlConfig = {
  completedTtlMs: DEFAULT_COMPLETED_TTL_MS,
  zombieInactivityMs: DEFAULT_ZOMBIE_INACTIVITY_MS,
  cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
};

let cleanupTimer: NodeJS.Timeout | null = null;

export type SessionRecord = {
  childSessionKey: string;
  endedAt?: number;
  startedAt?: number;
  lastActivityAt?: number;
  cleanupCompletedAt?: number;
};

export type SessionMetrics = {
  total: number;
  active: number;
  completed: number;
  zombie: number;
  expiredCompleted: number;
};

export function configureSessionTtl(partial: {
  completedTtlMinutes?: number;
  zombieInactivityMinutes?: number;
  cleanupIntervalMs?: number;
}): void {
  if (typeof partial.completedTtlMinutes === "number" && partial.completedTtlMinutes > 0) {
    config.completedTtlMs = Math.floor(partial.completedTtlMinutes) * 60_000;
  }
  if (typeof partial.zombieInactivityMinutes === "number" && partial.zombieInactivityMinutes > 0) {
    config.zombieInactivityMs = Math.floor(partial.zombieInactivityMinutes) * 60_000;
  }
  if (typeof partial.cleanupIntervalMs === "number" && partial.cleanupIntervalMs > 0) {
    config.cleanupIntervalMs = Math.floor(partial.cleanupIntervalMs);
  }
}

export function isCompletedExpired(record: SessionRecord, now?: number): boolean {
  const ts = now ?? Date.now();
  if (typeof record.endedAt !== "number") {
    return false;
  }
  return ts - record.endedAt >= config.completedTtlMs;
}

export function isZombie(record: SessionRecord, now?: number): boolean {
  const ts = now ?? Date.now();
  if (typeof record.endedAt === "number") {
    return false; // Completed sessions are not zombies
  }
  const lastActivity = record.lastActivityAt ?? record.startedAt ?? 0;
  if (lastActivity === 0) {
    return true; // No activity info at all — treat as zombie
  }
  return ts - lastActivity >= config.zombieInactivityMs;
}

export function computeSessionMetrics(
  records: Iterable<SessionRecord>,
  now?: number,
): SessionMetrics {
  const ts = now ?? Date.now();
  let total = 0;
  let active = 0;
  let completed = 0;
  let zombie = 0;
  let expiredCompleted = 0;

  for (const record of records) {
    total++;
    if (typeof record.endedAt === "number") {
      completed++;
      if (isCompletedExpired(record, ts)) {
        expiredCompleted++;
      }
    } else if (isZombie(record, ts)) {
      zombie++;
    } else {
      active++;
    }
  }

  return { total, active, completed, zombie, expiredCompleted };
}

export function logSessionMetrics(metrics: SessionMetrics): void {
  defaultRuntime.log(
    `[session-ttl] Metrics: total=${metrics.total} active=${metrics.active} ` +
      `completed=${metrics.completed} zombie=${metrics.zombie} ` +
      `expiredCompleted=${metrics.expiredCompleted}`,
  );
}

export type CleanupResult = {
  expiredSessionKeys: string[];
  zombieSessionKeys: string[];
  metrics: SessionMetrics;
};

export function identifyCleanupTargets(
  records: Iterable<SessionRecord>,
  now?: number,
): CleanupResult {
  const ts = now ?? Date.now();
  const expiredSessionKeys: string[] = [];
  const zombieSessionKeys: string[] = [];
  const allRecords: SessionRecord[] = [];

  for (const record of records) {
    allRecords.push(record);
    if (isCompletedExpired(record, ts)) {
      expiredSessionKeys.push(record.childSessionKey);
    } else if (isZombie(record, ts)) {
      zombieSessionKeys.push(record.childSessionKey);
    }
  }

  const metrics = computeSessionMetrics(allRecords, ts);
  return { expiredSessionKeys, zombieSessionKeys, metrics };
}

export function startPeriodicCleanup(cleanupFn: () => void | Promise<void>): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    void Promise.resolve(cleanupFn()).catch((err) => {
      defaultRuntime.log(`[session-ttl] Cleanup error: ${err}`);
    });
  }, config.cleanupIntervalMs);
  cleanupTimer.unref?.();
}

export function stopPeriodicCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function resetSessionTtlForTests(): void {
  stopPeriodicCleanup();
  config = {
    completedTtlMs: DEFAULT_COMPLETED_TTL_MS,
    zombieInactivityMs: DEFAULT_ZOMBIE_INACTIVITY_MS,
    cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
  };
}
