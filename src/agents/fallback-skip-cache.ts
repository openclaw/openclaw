// Process-local skip markers share credential failures across turns of a session.
// Restarting clears them so every fallback candidate gets another attempt.
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { modelKey } from "./model-ref-shared.js";

// Operators opt in with OPENCLAW_FALLBACK_SKIP_TTL_MS.
const DEFAULT_FALLBACK_SKIP_TTL_MS = 0;
const FALLBACK_SKIP_TTL_ENV = "OPENCLAW_FALLBACK_SKIP_TTL_MS";
const FALLBACK_SKIP_TTL_MIN_MS = 1_000;
const FALLBACK_SKIP_TTL_MAX_MS = 10 * 60_000;

function resolveConfiguredSkipTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseStrictNonNegativeInteger(env[FALLBACK_SKIP_TTL_ENV]);
  if (parsed === undefined) {
    return DEFAULT_FALLBACK_SKIP_TTL_MS;
  }
  if (parsed === 0) {
    return 0;
  }
  return Math.min(FALLBACK_SKIP_TTL_MAX_MS, Math.max(FALLBACK_SKIP_TTL_MIN_MS, parsed));
}

type SkipEntry = {
  expiresAtMs: number;
  reason: string;
};

type SkipBySession = Map<string, Map<string, SkipEntry>>;

type SkipCacheState = {
  buckets: SkipBySession;
  lastGlobalPruneAtMs: number;
};

// Bound full-cache scans on hot write/check paths.
const GLOBAL_PRUNE_INTERVAL_MS = 5_000;

function getState(): SkipCacheState {
  const globalStore = globalThis as typeof globalThis & {
    openclawFallbackSkipCacheState?: SkipCacheState;
  };
  return (globalStore.openclawFallbackSkipCacheState ??= {
    buckets: new Map(),
    lastGlobalPruneAtMs: 0,
  });
}

function candidateKey(provider: string, model: string, authScope?: string): string {
  return JSON.stringify([modelKey(provider, model), authScope?.trim() || null]);
}

function pruneExpired(bucket: Map<string, SkipEntry>, now: number): void {
  for (const [key, entry] of bucket.entries()) {
    if (entry.expiresAtMs <= now) {
      bucket.delete(key);
    }
  }
}

// One-off sessions may never be queried again; retire their expired buckets too.
function pruneAllExpired(now: number): void {
  const state = getState();
  if (now - state.lastGlobalPruneAtMs < GLOBAL_PRUNE_INTERVAL_MS) {
    return;
  }
  state.lastGlobalPruneAtMs = now;
  for (const [sessionId, bucket] of state.buckets.entries()) {
    pruneExpired(bucket, now);
    if (bucket.size === 0) {
      state.buckets.delete(sessionId);
    }
  }
}

export function markFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  authScope?: string;
  reason: string;
  now?: number;
  ttlMs?: number;
}): void {
  if (!params.sessionId || !params.provider || !params.model) {
    return;
  }
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? resolveConfiguredSkipTtlMs();
  if (ttlMs <= 0) {
    return;
  }
  pruneAllExpired(now);
  const buckets = getState().buckets;
  let bucket = buckets.get(params.sessionId);
  if (!bucket) {
    bucket = new Map();
    buckets.set(params.sessionId, bucket);
  }
  bucket.set(candidateKey(params.provider, params.model, params.authScope), {
    expiresAtMs: now + ttlMs,
    reason: params.reason,
  });
}

export function isFallbackCandidateSkipped(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  authScope?: string;
  now?: number;
}): boolean {
  if (!params.sessionId || !params.provider || !params.model) {
    return false;
  }
  const now = params.now ?? Date.now();
  pruneAllExpired(now);
  const buckets = getState().buckets;
  const bucket = buckets.get(params.sessionId);
  if (!bucket) {
    return false;
  }
  pruneExpired(bucket, now);
  if (bucket.size === 0) {
    buckets.delete(params.sessionId);
    return false;
  }
  const entry = bucket.get(candidateKey(params.provider, params.model, params.authScope));
  return Boolean(entry && entry.expiresAtMs > now);
}

export function getFallbackCandidateSkipReason(params: {
  sessionId: string | undefined;
  provider: string;
  model: string;
  authScope?: string;
  now?: number;
}): string | undefined {
  if (!params.sessionId || !params.provider || !params.model) {
    return undefined;
  }
  const bucket = getState().buckets.get(params.sessionId);
  if (!bucket) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const entry = bucket.get(candidateKey(params.provider, params.model, params.authScope));
  if (!entry || entry.expiresAtMs <= now) {
    return undefined;
  }
  return entry.reason;
}
