import { expectDefined } from "@openclaw/normalization-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import { SqliteSnapshotCleanupError } from "../../../infra/sqlite-readonly-location-cleanup.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
} from "../../../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../../../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../../state/openclaw-state-worker-error.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | { snapshot: Map<string, T>; changes?: never; lookup?: SubagentSessionReadLookup }
  | { snapshot?: undefined; changes?: Map<string, T | undefined>; lookup?: never }
) & {
  admission?: OpenClawStateDatabaseReadAdmission;
  sourceIdentity?: string;
  pending?: {
    promise: Promise<void>;
    ownerAbortSignal?: AbortSignal;
    cleanCancellation?: boolean;
  };
};

export type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  state: SubagentRunsCacheState<T>;
  captureAdmission?: (databasePath?: string) => OpenClawStateDatabaseReadAdmission;
  load?: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

export function getSessionListLookup<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): SubagentSessionReadLookup | undefined {
  const state = cache.state;
  if (!state.snapshot) {
    return undefined;
  }
  return (state.lookup ??= new SubagentSessionReadLookup(state.snapshot));
}

export function indexedSnapshotRows<T>(snapshot: Map<string, T>, keys: readonly string[]): T[] {
  return keys.map((key) => expectDefined(snapshot.get(key), "indexed subagent cache entry"));
}

export function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

export function captureSubagentFactsAdmission(databasePath = resolveOpenClawStateSqlitePath()) {
  return captureOpenClawStateDatabaseReadAdmission(databasePath);
}

function matchesSubagentCacheAdmission(
  previous: OpenClawStateDatabaseReadAdmission | undefined,
  current: OpenClawStateDatabaseReadAdmission | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (!current || previous.identity.key !== current.identity.key) {
    return false;
  }
  try {
    previous.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

export function applySubagentRunChanges<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  changes: Map<string, T | undefined> | undefined,
): Map<string, T> {
  for (const [runId, entry] of changes ?? []) {
    if (entry) {
      runs.set(runId, entry);
    } else {
      runs.delete(runId);
    }
  }
  return runs;
}

export function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  databasePath?: string,
): void {
  let admission: OpenClawStateDatabaseReadAdmission | undefined;
  try {
    admission = cache.captureAdmission?.(databasePath);
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    // Read retirement cannot turn committed or best-effort publication into a write failure.
    if (!cache.load) {
      cache.state = {};
      return;
    }
  }
  const previous =
    !admission ||
    (matchesSubagentCacheAdmission(cache.state.admission, admission) &&
      (cache.state.sourceIdentity === undefined ||
        cache.state.sourceIdentity === admission.identity.key))
      ? cache.state
      : {};
  admission ??= previous.admission;
  const snapshot = previous.snapshot;
  if (!changedRunIds) {
    cache.state = {
      snapshot: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
      admission,
      sourceIdentity: admission?.identity.key,
    };
    return;
  }
  if (!snapshot) {
    // Until the first full read, named writes cannot account for durable-only rows.
    const changes = previous.changes ?? new Map<string, T | undefined>();
    for (const runId of changedRunIds) {
      const entry = runs.get(runId);
      changes.set(runId, entry ? cache.copy(entry) : undefined);
    }
    cache.state = {
      changes,
      admission,
      sourceIdentity: admission?.identity.key,
      pending: previous.pending,
    };
    return;
  }
  const lookup = previous.lookup;
  // A failed projection/update cannot leave derived membership ahead of its Map.
  previous.lookup = undefined;
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.set(runId, cache.copy(entry));
    } else {
      snapshot.delete(runId);
    }
    lookup?.set(runId, snapshot.get(runId));
  }
  cache.state = {
    snapshot,
    admission,
    sourceIdentity: admission?.identity.key,
    ...(lookup ? { lookup } : {}),
  };
}

export function getPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> | null {
  if (!cache.load) {
    const context = captureOpenClawStateWorkerContext();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    if (
      !matchesSubagentCacheAdmission(cache.state.admission, context.admission) ||
      cache.state.sourceIdentity !== context.admission.identity.key
    ) {
      cache.state = {
        admission: captureSubagentFactsAdmission(context.admission.databasePath),
        sourceIdentity: context.admission.identity.key,
      };
      return null;
    }
  }
  return cache.state.snapshot ?? null;
}

export function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> {
  const cached = getPersistedSubagentRunsSnapshot(cache);
  if (cached) {
    return cached;
  }
  if (!cache.load) {
    throw new Error("Subagent session-list facts must be prepared before synchronous reads");
  }
  const runs = applySubagentRunChanges(cache.load(), cache.state.changes);
  const admission = cache.captureAdmission?.();
  cache.state = { snapshot: runs, admission, sourceIdentity: admission?.identity.key };
  return runs;
}

export function assertSubagentReadContext(context: OpenClawStateWorkerContext): void {
  getAsyncWorkSignal()?.throwIfAborted();
  context.maintenanceScope?.assertAdmission();
  context.admission.assertCurrent();
  const current = captureOpenClawStateWorkerContext();
  if (current.admission.identity.key !== context.admission.identity.key) {
    throw new Error("Subagent registry database changed during preparation");
  }
}

export function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    fresh?: boolean;
    borrowPersisted?: boolean;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
): Map<string, T> {
  if (
    shouldReadPersistedSubagentRuns() &&
    !cache.load &&
    !getPersistedSubagentRunsSnapshot(cache)
  ) {
    throw new Error("Subagent session-list facts must be prepared before synchronous reads");
  }
  const merged = new Map<string, T>();
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Scoped reads use indexed SQL until a complete owner snapshot is available.
      const cached = scope?.load && !scope.fresh ? getPersistedSubagentRunsSnapshot(cache) : null;
      const persisted = scope?.load
        ? (cached?.values() ?? scope.load())
        : loadPersistedSubagentRunsForRead(cache).values();
      for (const entry of persisted) {
        if (!scope || scope.matches(entry)) {
          merged.set(
            entry.runId,
            scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry,
          );
        }
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  if (shouldReadPersistedSubagentRuns()) {
    for (const [runId, entry] of cache.state.changes ?? []) {
      if (entry && (!scope || scope.matches(entry))) {
        merged.set(runId, scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry);
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (!scope || scope.matches(entry)) {
      merged.set(runId, cache.project(entry));
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export class SubagentSessionListUnavailableError extends Error {}

export async function readCompactSubagentRuns(context: OpenClawStateWorkerContext) {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.sessionList" },
  );
  if (!reply) {
    return new Map<string, SubagentRunReadRecord>();
  }
  if (!reply.ok || reply.type !== "subagents.sessionList") {
    throw new Error("Unexpected compact subagent registry read result");
  }
  if ("unavailable" in reply) {
    const failure = new Error(reply.unavailable.message);
    retainOpenClawStateWorkerErrorPayload(failure, reply.unavailable.error);
    throw new SubagentSessionListUnavailableError(reply.unavailable.message, {
      cause: hydrateOpenClawStateWorkerError(failure, { includeOrdinary: true }),
    });
  }
  return reply.runs;
}

export async function readFullSubagentRuns(
  context: OpenClawStateWorkerContext,
  scope: { kind: "session"; sessionKey: string } | { kind: "ids"; runIds: readonly string[] },
) {
  if (scope.kind === "ids" && scope.runIds.length === 0) {
    assertSubagentReadContext(context);
    return new Map<string, SubagentRunRecord>();
  }
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.runs", scope },
  );
  assertSubagentReadContext(context);
  if (!reply) {
    return new Map<string, SubagentRunRecord>();
  }
  if (!reply.ok || reply.type !== "subagents.runs") {
    throw new Error("Unexpected subagent registry read result");
  }
  return reply.runs;
}

export async function prepareSubagentRunsCache<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  load: (context: OpenClawStateWorkerContext) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const context = captureOpenClawStateWorkerContext();
  assertSubagentReadContext(context);
  if (getActiveOpenClawStateDatabaseReadSnapshot()) {
    // Private snapshot bytes never become canonical resident facts.
    const runs = await load(context);
    assertSubagentReadContext(context);
    return runs;
  }
  const callerAbortSignal = getAsyncWorkSignal();
  let retriedCanceledFill = false;
  while (true) {
    assertSubagentReadContext(context);
    let state = cache.state;
    if (
      !matchesSubagentCacheAdmission(state.admission, context.admission) ||
      (state.sourceIdentity !== undefined &&
        state.sourceIdentity !== context.admission.identity.key)
    ) {
      cache.state = state = {
        admission: captureSubagentFactsAdmission(context.admission.databasePath),
        sourceIdentity: context.admission.identity.key,
      };
    }
    if (state.snapshot) {
      return state.snapshot;
    }
    if (!state.pending) {
      const sourceIdentity = context.admission.identity.key;
      // Readiness checks must recognize the pending fill before its facts exist.
      state.admission = captureSubagentFactsAdmission(context.admission.databasePath);
      state.sourceIdentity = sourceIdentity;
      const fill: NonNullable<SubagentRunsCacheState<T>["pending"]> = {
        ownerAbortSignal: callerAbortSignal,
        promise: Promise.resolve().then(async () => {
          const runs = await load(context);
          try {
            assertSubagentReadContext(context);
          } catch (error) {
            // Classify only after successful read cleanup, before waiters observe rejection.
            fill.cleanCancellation =
              fill.ownerAbortSignal?.aborted === true &&
              error === fill.ownerAbortSignal.reason &&
              !(error instanceof AggregateError) &&
              !isStateDatabaseReadAdmissionInvalidatedError(error) &&
              !(error instanceof SqliteSnapshotCleanupError);
            throw error;
          }
          if (cache.state.pending === fill) {
            const admission = captureSubagentFactsAdmission(context.admission.databasePath);
            cache.state =
              sourceIdentity === admission.identity.key
                ? {
                    snapshot: applySubagentRunChanges(runs, cache.state.changes),
                    admission,
                    sourceIdentity,
                  }
                : {
                    changes: cache.state.changes,
                    admission,
                    sourceIdentity: admission.identity.key,
                  };
          }
        }),
      };
      state.pending = fill;
    }
    const fill = state.pending;
    try {
      await fill.promise;
    } catch (error) {
      if (
        !fill.cleanCancellation ||
        fill.ownerAbortSignal === callerAbortSignal ||
        retriedCanceledFill
      ) {
        throw error;
      }
      assertSubagentReadContext(context);
      retriedCanceledFill = true;
    } finally {
      if (cache.state.pending === fill) {
        cache.state.pending = undefined;
      }
    }
  }
}

export function acceptedFullSnapshot(
  cache: SubagentRunsCache<SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
) {
  const state = cache.state;
  return !getActiveOpenClawStateDatabaseReadSnapshot() &&
    state.sourceIdentity === context.admission.identity.key &&
    matchesSubagentCacheAdmission(state.admission, context.admission)
    ? state.snapshot
    : undefined;
}

export function consumeSubagentRuns<T>(
  runs: Map<string, SubagentRunRecord>,
  consume: (runs: ReadonlyMap<string, SubagentRunRecord>) => T,
): T {
  getAsyncWorkSignal()?.throwIfAborted();
  const result = consume(runs);
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Subagent registry read consumers must remain synchronous");
  }
  return result;
}

export function mergeSelectedFullRuns(
  cache: SubagentRunsCache<SubagentRunRecord>,
  inMemoryRuns: Map<string, SubagentRunRecord>,
  persisted: Map<string, SubagentRunRecord>,
  matches: (entry: SubagentRunReadRecord) => boolean,
  context?: OpenClawStateWorkerContext,
): Map<string, SubagentRunRecord> {
  const current = context ? acceptedFullSnapshot(cache, context) : undefined;
  const merged = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of current ?? persisted) {
    if (matches(entry)) {
      merged.set(runId, current ? structuredClone(entry) : entry);
    }
  }
  const state = cache.state;
  if (
    context &&
    !getActiveOpenClawStateDatabaseReadSnapshot() &&
    state.sourceIdentity === context.admission.identity.key &&
    matchesSubagentCacheAdmission(state.admission, context.admission)
  ) {
    for (const [runId, entry] of state.changes ?? []) {
      if (entry && matches(entry)) {
        merged.set(runId, structuredClone(entry));
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (matches(entry)) {
      merged.set(runId, entry);
    } else {
      merged.delete(runId);
    }
  }
  return merged;
}
