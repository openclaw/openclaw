/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
  loadSubagentRegistryFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRunsForRequesterFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RUNS_READ_CACHE_TTL_MS = 500;

let persistedSubagentRunsReadCache:
  | {
      loadedAtMs: number;
      runs: Map<string, SubagentRunRecord>;
    }
  | undefined;

// Scoped per-controller-key caches avoid repeated SQLite queries for the
// same controller inside the TTL window (e.g. repeated status/control calls
// and recursive multi-controller traversals).  Invalidation is tied to
// persistSubagentRunsToDisk so stale data lasts at most one TTL window.
let scopedControllerCache:
  | Map<string, { loadedAtMs: number; runs: Map<string, SubagentRunRecord> }>
  | undefined;

function getScopedControllerCache(): Map<
  string,
  { loadedAtMs: number; runs: Map<string, SubagentRunRecord> }
> {
  if (!scopedControllerCache) {
    scopedControllerCache = new Map();
  }
  return scopedControllerCache;
}

function cloneSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs.entries()].map(([runId, entry]) => [runId, structuredClone(entry)]));
}

function rememberPersistedSubagentRunsSnapshot(runs: Map<string, SubagentRunRecord>): void {
  persistedSubagentRunsReadCache = {
    loadedAtMs: Date.now(),
    runs: cloneSubagentRunsSnapshot(runs),
  };
}

function loadPersistedSubagentRunsForRead(): Map<string, SubagentRunRecord> {
  const nowMs = Date.now();
  if (
    persistedSubagentRunsReadCache &&
    nowMs >= persistedSubagentRunsReadCache.loadedAtMs &&
    nowMs - persistedSubagentRunsReadCache.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
  ) {
    return persistedSubagentRunsReadCache.runs;
  }

  const runs = loadSubagentRegistryFromSqlite();
  persistedSubagentRunsReadCache = {
    loadedAtMs: nowMs,
    runs,
  };
  return runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache = undefined;
  scopedControllerCache = undefined;
}

function invalidateScopedControllerCache(): void {
  if (scopedControllerCache) {
    scopedControllerCache.clear();
  }
}

function getCachedControllerRuns(
  controllerKey: string,
): Map<string, SubagentRunRecord> | undefined {
  const cache = scopedControllerCache;
  if (!cache) {
    return undefined;
  }
  const entry = cache.get(controllerKey);
  if (!entry) {
    return undefined;
  }
  const nowMs = Date.now();
  if (nowMs - entry.loadedAtMs >= SUBAGENT_RUNS_READ_CACHE_TTL_MS) {
    cache.delete(controllerKey);
    return undefined;
  }
  return entry.runs;
}

function setCachedControllerRuns(
  controllerKey: string,
  runs: Map<string, SubagentRunRecord>,
): void {
  getScopedControllerCache().set(controllerKey, {
    loadedAtMs: Date.now(),
    runs,
  });
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToSqlite(runs);
    rememberPersistedSubagentRunsSnapshot(runs);
    invalidateScopedControllerCache();
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToSqlite(runs);
  rememberPersistedSubagentRunsSnapshot(runs);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      // Cache this hot cross-process snapshot briefly; writes refresh the local
      // cache and the TTL bounds visibility of changes from other processes.
      for (const [runId, entry] of loadPersistedSubagentRunsForRead().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}

/**
 * Scoped snapshot for a single requester session key.
 *
 * Loads only persisted rows matching the requester instead of hydrating the
 * entire registry, then overlays in-memory runs that also match.
 */
export function getSubagentRunsSnapshotForRequester(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = requesterSessionKey.trim();
  if (!key) {
    return new Map();
  }
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      for (const entry of loadSubagentRunsForRequesterFromSqlite(key)) {
        merged.set(entry.runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    if (entry.requesterSessionKey === key) {
      merged.set(runId, entry);
    }
  }
  return merged;
}

function resolveControllerSessionKey(entry: SubagentRunRecord): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

/**
 * Scoped snapshot for a single controller session key.
 *
 * Loads only persisted rows matching the controller (including the fallback
 * from null controller to requester key), then overlays in-memory runs that
 * also match through the same resolution.
 *
 * Caches SQL results per controller key with the same TTL used by the
 * full-snapshot path ({@link SUBAGENT_RUNS_READ_CACHE_TTL_MS}), so repeated
 * status/control calls and recursive controller traversals reuse indexed
 * reads instead of issuing a synchronous SQLite query on every lookup.
 */
export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return new Map();
  }
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      const cached = getCachedControllerRuns(key);
      if (cached) {
        for (const [runId, entry] of cached.entries()) {
          merged.set(runId, entry);
        }
      } else {
        const loaded = new Map<string, SubagentRunRecord>();
        for (const entry of loadSubagentRunsForControllerFromSqlite(key)) {
          merged.set(entry.runId, entry);
          loaded.set(entry.runId, entry);
        }
        setCachedControllerRuns(key, loaded);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    if (resolveControllerSessionKey(entry) === key) {
      merged.set(runId, entry);
    }
  }
  return merged;
}
