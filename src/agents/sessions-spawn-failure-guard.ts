import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/sessions-spawn-failure-guard");

/** Repeated unrecoverable `sessions_spawn` failures are suppressed within this window. */
export const SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS = 30_000;
export const SESSIONS_SPAWN_FAILURE_GUARD_TTL_MAX_MS = 120_000;
export const SESSIONS_SPAWN_FAILURE_BUDGET_WINDOW_MS = 120_000;
export const SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT = 8;
export const SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MS = 30_000;
export const SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MAX_MS = 120_000;

export type SessionsSpawnFailureCode =
  | "allowlist_denied"
  | "missing_config"
  | "missing_workspace"
  | "stale_allowlist"
  | "validation_error"
  | "depth_limit"
  | "max_children"
  | "sandbox_mismatch";

type FailureGuardEntry = {
  code: SessionsSpawnFailureCode;
  status: "error" | "forbidden";
  error: string;
  strikeCount: number;
  ttlMs: number;
  expiresAt: number;
};

const failureGuardCache = new Map<string, FailureGuardEntry>();
type FailureBudgetEntry = {
  recentFailureTimestamps: number[];
  blockedUntil: number;
  blockStrikeCount: number;
};
const failureBudgetCache = new Map<string, FailureBudgetEntry>();

function pruneExpiredFailureEntries(nowMs: number): void {
  for (const [key, entry] of failureGuardCache) {
    if (entry.expiresAt <= nowMs) {
      failureGuardCache.delete(key);
    }
  }
}

function pruneFailureBudgetEntry(entry: FailureBudgetEntry, nowMs: number): void {
  entry.recentFailureTimestamps = entry.recentFailureTimestamps.filter(
    (timestamp) => nowMs - timestamp <= SESSIONS_SPAWN_FAILURE_BUDGET_WINDOW_MS,
  );
}

function resolveEscalatingTtlMs(params: {
  baseTtlMs: number;
  maxTtlMs: number;
  strikeCount: number;
}): number {
  if (params.strikeCount <= 1) {
    return params.baseTtlMs;
  }
  if (params.strikeCount === 2) {
    return Math.min(params.maxTtlMs, params.baseTtlMs * 2);
  }
  return params.maxTtlMs;
}

export function buildSessionsSpawnFailureGuardKey(params: {
  requesterInternalKey: string;
  targetAgentId: string;
}): string {
  const h = crypto.createHash("sha256");
  h.update(params.requesterInternalKey, "utf8");
  h.update("\u0000");
  h.update(params.targetAgentId, "utf8");
  return h.digest("hex");
}

export function peekSessionsSpawnFailureGuard(params: {
  guardKey: string;
  nowMs?: number;
}): FailureGuardEntry | undefined {
  const now = params.nowMs ?? Date.now();
  pruneExpiredFailureEntries(now);
  const hit = failureGuardCache.get(params.guardKey);
  if (!hit) {
    return undefined;
  }
  if (hit.expiresAt <= now) {
    failureGuardCache.delete(params.guardKey);
    return undefined;
  }
  return hit;
}

export function recordSessionsSpawnFailureGuard(params: {
  guardKey: string;
  code: SessionsSpawnFailureCode;
  status: "error" | "forbidden";
  error: string;
  nowMs?: number;
}): FailureGuardEntry {
  const now = params.nowMs ?? Date.now();
  pruneExpiredFailureEntries(now);
  const existing = failureGuardCache.get(params.guardKey);
  const strikeCount =
    existing?.expiresAt && existing.expiresAt > now ? existing.strikeCount + 1 : 1;
  const ttlMs = resolveEscalatingTtlMs({
    baseTtlMs: SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS,
    maxTtlMs: SESSIONS_SPAWN_FAILURE_GUARD_TTL_MAX_MS,
    strikeCount,
  });
  const nextEntry: FailureGuardEntry = {
    code: params.code,
    status: params.status,
    error: params.error,
    strikeCount,
    ttlMs,
    expiresAt: now + ttlMs,
  };
  failureGuardCache.set(params.guardKey, nextEntry);
  return nextEntry;
}

export function buildSessionsSpawnFailureBudgetKey(params: {
  requesterInternalKey: string;
}): string {
  const h = crypto.createHash("sha256");
  h.update(params.requesterInternalKey, "utf8");
  return h.digest("hex");
}

export function peekSessionsSpawnFailureBudget(params: { budgetKey: string; nowMs?: number }):
  | {
      blockedUntil: number;
      retryAfterMs: number;
      blockStrikeCount: number;
      recentFailureCount: number;
    }
  | undefined {
  const now = params.nowMs ?? Date.now();
  const entry = failureBudgetCache.get(params.budgetKey);
  if (!entry) {
    return undefined;
  }
  pruneFailureBudgetEntry(entry, now);
  if (entry.blockedUntil <= now) {
    if (entry.recentFailureTimestamps.length === 0) {
      failureBudgetCache.delete(params.budgetKey);
    }
    return undefined;
  }
  return {
    blockedUntil: entry.blockedUntil,
    retryAfterMs: Math.max(0, entry.blockedUntil - now),
    blockStrikeCount: entry.blockStrikeCount,
    recentFailureCount: entry.recentFailureTimestamps.length,
  };
}

export function recordSessionsSpawnFailureBudget(params: { budgetKey: string; nowMs?: number }): {
  blockedUntil?: number;
  retryAfterMs?: number;
  blockStrikeCount: number;
  recentFailureCount: number;
} {
  const now = params.nowMs ?? Date.now();
  const entry =
    failureBudgetCache.get(params.budgetKey) ??
    ({
      recentFailureTimestamps: [],
      blockedUntil: 0,
      blockStrikeCount: 0,
    } satisfies FailureBudgetEntry);
  pruneFailureBudgetEntry(entry, now);
  entry.recentFailureTimestamps.push(now);

  const shouldBlock =
    entry.blockedUntil > now ||
    entry.recentFailureTimestamps.length >= SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT;
  if (shouldBlock) {
    entry.blockStrikeCount += 1;
    const ttlMs = resolveEscalatingTtlMs({
      baseTtlMs: SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MS,
      maxTtlMs: SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MAX_MS,
      strikeCount: entry.blockStrikeCount,
    });
    entry.blockedUntil = now + ttlMs;
  }

  failureBudgetCache.set(params.budgetKey, entry);
  return shouldBlock
    ? {
        blockedUntil: entry.blockedUntil,
        retryAfterMs: Math.max(0, entry.blockedUntil - now),
        blockStrikeCount: entry.blockStrikeCount,
        recentFailureCount: entry.recentFailureTimestamps.length,
      }
    : {
        blockStrikeCount: entry.blockStrikeCount,
        recentFailureCount: entry.recentFailureTimestamps.length,
      };
}

export function logSessionsSpawnFailureGuardHit(meta: {
  targetAgentId: string;
  requesterInternalKey: string;
  code: SessionsSpawnFailureCode;
  ttlMs: number;
  strikeCount: number;
}): void {
  log.warn("sessions_spawn retry suppressed after unrecoverable failure", {
    targetAgentId: meta.targetAgentId,
    requesterInternalKey: meta.requesterInternalKey,
    code: meta.code,
    ttlMs: meta.ttlMs,
    strikeCount: meta.strikeCount,
  });
}

export function logSessionsSpawnFailureBudgetHit(meta: {
  requesterInternalKey: string;
  retryAfterMs: number;
  blockStrikeCount: number;
  recentFailureCount: number;
}): void {
  log.warn("sessions_spawn temporarily blocked after repeated failures", {
    requesterInternalKey: meta.requesterInternalKey,
    retryAfterMs: meta.retryAfterMs,
    blockStrikeCount: meta.blockStrikeCount,
    recentFailureCount: meta.recentFailureCount,
  });
}

/** Test-only: clear failure-guard state between cases. */
export function resetSessionsSpawnFailureGuardForTests(): void {
  failureGuardCache.clear();
  failureBudgetCache.clear();
}
