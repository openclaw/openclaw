import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/sessions-spawn-dedup");

/** Recent duplicate `sessions_spawn` calls return the same child session within this window. */
export const SESSIONS_SPAWN_DEDUP_TTL_MS = 60_000;

type DedupCacheEntry = {
  childSessionKey: string;
  runId: string;
  expiresAt: number;
};

const dedupCache = new Map<string, DedupCacheEntry>();

function pruneExpiredDedupEntries(nowMs: number): void {
  for (const [key, entry] of dedupCache) {
    if (entry.expiresAt <= nowMs) {
      dedupCache.delete(key);
    }
  }
}

/**
 * Stable hash for recent spawn deduplication.
 * Includes requester scope so unrelated sessions never share an entry.
 */
export function buildSessionsSpawnDedupKey(params: {
  requesterInternalKey: string;
  targetAgentId: string;
  objectiveText: string;
  minuteEpoch: number;
  /** Distinguishes subagent vs ACP and materially different spawn options. */
  variant: string;
}): string {
  const h = crypto.createHash("sha256");
  h.update(params.requesterInternalKey, "utf8");
  h.update("\u0000");
  h.update(params.targetAgentId, "utf8");
  h.update("\u0000");
  h.update(params.objectiveText, "utf8");
  h.update("\u0000");
  h.update(String(params.minuteEpoch), "utf8");
  h.update("\u0000");
  h.update(params.variant, "utf8");
  return h.digest("hex");
}

export function getSpawnDedupMinuteEpoch(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 60_000);
}

export function peekSessionsSpawnDedup(params: {
  dedupKey: string;
  nowMs?: number;
}): DedupCacheEntry | undefined {
  const now = params.nowMs ?? Date.now();
  pruneExpiredDedupEntries(now);
  const hit = dedupCache.get(params.dedupKey);
  if (!hit) {
    return undefined;
  }
  if (hit.expiresAt <= now) {
    dedupCache.delete(params.dedupKey);
    return undefined;
  }
  return hit;
}

export function recordSessionsSpawnDedup(params: {
  dedupKey: string;
  childSessionKey: string;
  runId: string;
  nowMs?: number;
}): void {
  const now = params.nowMs ?? Date.now();
  pruneExpiredDedupEntries(now);
  dedupCache.set(params.dedupKey, {
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    expiresAt: now + SESSIONS_SPAWN_DEDUP_TTL_MS,
  });
}

export function logSessionsSpawnDedupHit(meta: {
  targetAgentId: string;
  requesterInternalKey: string;
  childSessionKey: string;
  runId: string;
  minuteEpoch: number;
  objectiveCharCount: number;
}): void {
  log.info("sessions_spawn deduplicated (within TTL)", {
    targetAgentId: meta.targetAgentId,
    requesterInternalKey: meta.requesterInternalKey,
    childSessionKey: meta.childSessionKey,
    runId: meta.runId,
    minuteEpoch: meta.minuteEpoch,
    objectiveCharCount: meta.objectiveCharCount,
  });
}

/** Test-only: clear dedup state between cases. */
export function resetSessionsSpawnDedupForTests(): void {
  dedupCache.clear();
}
