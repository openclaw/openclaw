import crypto from "node:crypto";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { closeActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readActiveMemoryConfig } from "./config.js";
import {
  CACHE_SWEEP_INTERVAL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  MAX_LOG_VALUE_CHARS,
  type ActiveRecallResult,
  type CachedActiveRecallResult,
  type CircuitBreakerEntry,
} from "./types.js";

let lastActiveRecallCacheSweepAt = 0;
const activeRecallCache = new Map<string, CachedActiveRecallResult>();
type ActiveRecallRunEntry = {
  promise: Promise<ActiveRecallResult>;
  timeoutCleanup?: Promise<void>;
};
const activeRecallRuns = new Map<string, ActiveRecallRunEntry>();
const timeoutCircuitBreaker = new Map<string, CircuitBreakerEntry>();
type MemoryAudience = NonNullable<OpenClawPluginToolContext["memoryAudience"]>;

export function buildMemoryAudienceCacheIdentity(audience: MemoryAudience | undefined): string {
  if (!audience) {
    return "none";
  }
  return JSON.stringify(
    audience.kind === "owner-private"
      ? [audience.kind, audience.agentId]
      : [audience.kind, audience.agentId, audience.sessionKey, audience.sessionId],
  );
}

export function buildCircuitBreakerKey(agentId: string, provider?: string, model?: string): string {
  return `${agentId}:${provider ?? "unknown"}/${model ?? "unknown"}`;
}

export function isCircuitBreakerOpen(
  key: string,
  maxTimeouts: number,
  cooldownMs: number,
): boolean {
  const entry = timeoutCircuitBreaker.get(key);
  if (!entry || entry.consecutiveTimeouts < maxTimeouts) {
    return false;
  }
  // Cooldown allows another attempt; only a completed recall clears the streak.
  return Date.now() - entry.lastTimeoutAt < cooldownMs;
}

export function recordCircuitBreakerTimeout(key: string): void {
  const entry = timeoutCircuitBreaker.get(key);
  // Reinsertion keeps refreshed keys newer than peers when capacity eviction runs.
  timeoutCircuitBreaker.delete(key);
  timeoutCircuitBreaker.set(key, {
    consecutiveTimeouts: (entry?.consecutiveTimeouts ?? 0) + 1,
    lastTimeoutAt: Date.now(),
  });
  pruneMapToMaxSize(timeoutCircuitBreaker, DEFAULT_MAX_CACHE_ENTRIES);
}

export function resetCircuitBreaker(key: string): void {
  timeoutCircuitBreaker.delete(key);
}

export function scheduleMemorySearchCleanupAfterTimeout(
  api: OpenClawPluginApi,
  logPrefix: string,
  agentId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const cfg = readActiveMemoryConfig(api);
    setTimeout(() => {
      void closeActiveMemorySearchManager({ cfg, agentId })
        .then(() => {
          api.logger.debug?.(`${logPrefix} released memory search managers after timeout`);
        })
        .catch((error: unknown) => {
          const message = toSingleLineErrorMessage(error);
          api.logger.warn?.(
            `${logPrefix} failed to release memory search managers after timeout: ${message}`,
          );
        })
        .finally(resolve);
    }, 0);
  });
}

export async function resolveActiveRecallForRun(
  runId: string,
  start: (onTimeoutCleanup: (cleanup: Promise<void>) => void) => Promise<ActiveRecallResult>,
): Promise<ActiveRecallResult> {
  const existing = activeRecallRuns.get(runId);
  if (existing?.timeoutCleanup) {
    // A replacement must not reuse managers while the timed-out recall or its
    // cleanup is still settling; concurrent callers then join the replacement.
    await Promise.allSettled([existing.promise, existing.timeoutCleanup]);
    if (activeRecallRuns.get(runId) === existing) {
      activeRecallRuns.delete(runId);
    }
    return await resolveActiveRecallForRun(runId, start);
  }
  if (existing) {
    return await existing.promise;
  }

  const entry: ActiveRecallRunEntry = {
    promise: Promise.resolve().then(() =>
      start((cleanup) => {
        entry.timeoutCleanup = cleanup;
        void Promise.allSettled([entry.promise, cleanup]).then(() => {
          if (activeRecallRuns.get(runId) === entry) {
            activeRecallRuns.delete(runId);
          }
        });
      }),
    ),
  };
  activeRecallRuns.set(runId, entry);
  void entry.promise.catch(() => {
    // Failures before timeout cleanup starts must not poison this run;
    // timeout-backed entries stay registered until manager cleanup settles.
    if (!entry.timeoutCleanup && activeRecallRuns.get(runId) === entry) {
      activeRecallRuns.delete(runId);
    }
  });
  // Fulfilled results remain stable through agent_end, including `failed`;
  // rerunning them would recreate the redundant same-turn recalls this registry prevents.
  return await entry.promise;
}

export function forgetActiveRecallRun(runId: string | undefined): void {
  if (runId) {
    for (const key of activeRecallRuns.keys()) {
      if (key === runId || key.startsWith(`${runId}:`)) {
        activeRecallRuns.delete(key);
      }
    }
  }
}

export function buildCacheKey(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
  authorityFingerprint: string;
  memoryAudience?: MemoryAudience;
  memorySlot?: string;
  activeProjectKeys?: string[];
  modelProviderId?: string;
  modelId?: string;
  recallToolNames: string[];
  resourceScope?: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        query: params.query,
        authorityFingerprint: params.authorityFingerprint,
        memoryAudience: buildMemoryAudienceCacheIdentity(params.memoryAudience),
        memorySlot: params.memorySlot,
        activeProjectKeys: params.activeProjectKeys?.toSorted() ?? [],
        modelProviderId: params.modelProviderId,
        modelId: params.modelId,
        recallToolNames: params.recallToolNames.toSorted(),
        resourceScope: params.resourceScope,
      }),
    )
    .digest("hex");
  return `${params.agentId}:${params.sessionKey ?? params.sessionId ?? "none"}:${hash}`;
}

export function getCachedResult(cacheKey: string): ActiveRecallResult | undefined {
  const cached = activeRecallCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    activeRecallCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

export function setCachedResult(cacheKey: string, result: ActiveRecallResult, ttlMs: number): void {
  const now = Date.now();
  if (
    activeRecallCache.size >= DEFAULT_MAX_CACHE_ENTRIES ||
    now - lastActiveRecallCacheSweepAt >= CACHE_SWEEP_INTERVAL_MS
  ) {
    sweepExpiredCacheEntries(now);
    lastActiveRecallCacheSweepAt = now;
  }
  activeRecallCache.delete(cacheKey);
  activeRecallCache.set(cacheKey, {
    expiresAt: now + ttlMs,
    result,
  });
  pruneMapToMaxSize(activeRecallCache, DEFAULT_MAX_CACHE_ENTRIES);
}

function sweepExpiredCacheEntries(now: number): void {
  for (const [cacheKey, cached] of activeRecallCache.entries()) {
    if (cached.expiresAt <= now) {
      activeRecallCache.delete(cacheKey);
    }
  }
}

export function toSingleLineLogValue(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_LOG_VALUE_CHARS
    ? `${truncateUtf16Safe(singleLine, MAX_LOG_VALUE_CHARS)}...`
    : singleLine;
}

export function toSingleLineErrorMessage(error: unknown): string {
  return toSingleLineLogValue(coerceErrorMessage(error));
}

export function shouldCacheResult(result: ActiveRecallResult): boolean {
  return result.status === "ok" && result.summary.length > 0;
}
