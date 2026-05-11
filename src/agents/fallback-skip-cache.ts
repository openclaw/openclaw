/**
 * Session-scoped "known-bad candidate" cache for the model fallback chain.
 *
 * When a fallback candidate fails with a non-transient credential error
 * (`auth` / `auth_permanent`) the chain should not retry the same candidate on
 * every subsequent turn until the user fixes their auth — that wastes latency
 * and emits confusing repeated error logs.
 *
 * This module records skip markers per `(sessionId, provider, model)` with a
 * short TTL. The cache is intentionally in-memory only: a process restart
 * clears it so a freshly-restarted gateway always tries every candidate at
 * least once before deciding to skip again.
 *
 * The cache is global, not per-config, so any caller running fallbacks for the
 * same `sessionId` shares the same skip set. Tests can reset state via
 * `__resetFallbackSkipCacheForTest()`.
 */

import { modelKey } from "./model-selection-normalize.js";

/**
 * Default time-to-live for a skip marker. 60 seconds is short enough that a
 * user who fixes their auth quickly will see the candidate re-tried on the
 * next turn, and long enough to suppress the no-op retries within a typical
 * conversation burst.
 */
export const DEFAULT_FALLBACK_SKIP_TTL_MS = 60_000;
const FALLBACK_SKIP_TTL_ENV = "OPENCLAW_FALLBACK_SKIP_TTL_MS";
const FALLBACK_SKIP_TTL_MIN_MS = 1_000;
const FALLBACK_SKIP_TTL_MAX_MS = 10 * 60_000;

function resolveConfiguredSkipTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FALLBACK_SKIP_TTL_ENV];
  if (!raw) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  return Math.min(FALLBACK_SKIP_TTL_MAX_MS, Math.max(FALLBACK_SKIP_TTL_MIN_MS, parsed));
}

type SkipEntry = {
  expiresAtMs: number;
  reason: string;
};

type SkipBySession = Map<string, Map<string, SkipEntry>>;

function getState(): SkipBySession {
  const globalStore = globalThis as typeof globalThis & {
    __openclawFallbackSkipCache?: SkipBySession;
  };
  if (!globalStore.__openclawFallbackSkipCache) {
    globalStore.__openclawFallbackSkipCache = new Map();
  }
  return globalStore.__openclawFallbackSkipCache;
}

function sessionBucket(sessionId: string, create: boolean): Map<string, SkipEntry> | undefined {
  const state = getState();
  let bucket = state.get(sessionId);
  if (!bucket && create) {
    bucket = new Map();
    state.set(sessionId, bucket);
  }
  return bucket;
}

function candidateKey(provider: string, model: string): string {
  return modelKey(provider, model);
}

function pruneExpired(bucket: Map<string, SkipEntry>, now: number): void {
  for (const [key, entry] of bucket.entries()) {
    if (entry.expiresAtMs <= now) {
      bucket.delete(key);
    }
  }
}

/**
 * Record that `(sessionId, provider, model)` should be skipped for the
 * configured TTL. Safe to call with falsy `sessionId` — the call becomes a
 * no-op so callers do not need to guard themselves.
 */
export function markFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  reason: string;
  now?: number;
  ttlMs?: number;
}): void {
  if (!params.sessionId || !params.provider || !params.model) {
    return;
  }
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? resolveConfiguredSkipTtlMs();
  const bucket = sessionBucket(params.sessionId, true);
  if (!bucket) {
    return;
  }
  bucket.set(candidateKey(params.provider, params.model), {
    expiresAtMs: now + ttlMs,
    reason: params.reason,
  });
}

/**
 * Returns true when `(sessionId, provider, model)` has an unexpired skip
 * marker. Expired entries are pruned as a side-effect so the cache does not
 * grow unbounded.
 */
export function isFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  now?: number;
}): boolean {
  if (!params.sessionId || !params.provider || !params.model) {
    return false;
  }
  const bucket = sessionBucket(params.sessionId, false);
  if (!bucket) {
    return false;
  }
  const now = params.now ?? Date.now();
  pruneExpired(bucket, now);
  if (bucket.size === 0) {
    getState().delete(params.sessionId);
    return false;
  }
  const entry = bucket.get(candidateKey(params.provider, params.model));
  return Boolean(entry && entry.expiresAtMs > now);
}

/**
 * Look up the recorded skip reason for a `(sessionId, provider, model)`
 * triple. Returns `undefined` when no unexpired marker exists. Used by the
 * fallback chain to surface the original failure reason in observation logs.
 */
export function getFallbackCandidateSkipReason(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  now?: number;
}): string | undefined {
  if (!params.sessionId || !params.provider || !params.model) {
    return undefined;
  }
  const bucket = sessionBucket(params.sessionId, false);
  if (!bucket) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const entry = bucket.get(candidateKey(params.provider, params.model));
  if (!entry || entry.expiresAtMs <= now) {
    return undefined;
  }
  return entry.reason;
}

/** Drop every skip marker associated with the given session. */
export function clearFallbackSkipCacheForSession(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  getState().delete(sessionId);
}

/**
 * Test-only escape hatch. Production code must not call this; the global
 * cache is meant to outlive individual fallback runs.
 */
export function __resetFallbackSkipCacheForTest(): void {
  getState().clear();
}
