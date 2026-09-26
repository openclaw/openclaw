import { expectDefined } from "@openclaw/normalization-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import { SqliteSnapshotCleanupError } from "../../../infra/sqlite-readonly-location-cleanup.js";
import type { DatabasePathIdentity } from "../../../infra/sqlite-worker-identity.js";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
} from "../../../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
} from "../../../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../../state/openclaw-state-worker-error.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentRunIdLookup } from "./subagent-run-id-lookup.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

type SubagentRunChange<T> = { entry: T | undefined; committed: boolean };

export type SubagentRunPublication = { committed?: boolean; databasePath?: string };

type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | {
      snapshot: Map<string, T>;
      lookup?: SubagentSessionReadLookup;
      runIdLookup?: SubagentRunIdLookup;
      replacementPending?: true;
    }
  | { snapshot?: undefined; lookup?: never; runIdLookup?: never; replacementPending?: never }
) & {
  changes?: Map<string, SubagentRunChange<T>>;
  admission?: OpenClawStateDatabaseReadAdmission;
  sourceIdentity?: string;
  retiredPublicationIdentity?: DatabasePathIdentity;
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
  snapshot = cache.state.snapshot,
): SubagentSessionReadLookup | undefined {
  const state = cache.state;
  if (!snapshot) {
    return undefined;
  }
  if (state.snapshot !== snapshot) {
    return new SubagentSessionReadLookup(snapshot);
  }
  return (state.lookup ??= new SubagentSessionReadLookup(snapshot));
}

export function indexedSnapshotRows<T>(snapshot: Map<string, T>, keys: readonly string[]): T[] {
  return keys.map((key) => expectDefined(snapshot.get(key), "indexed subagent cache entry"));
}

export function getPersistedRunIdLookup<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  snapshot: Map<string, T>,
): SubagentRunIdLookup {
  return cache.state.snapshot === snapshot
    ? (cache.state.runIdLookup ??= new SubagentRunIdLookup(snapshot))
    : new SubagentRunIdLookup(snapshot);
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
  changes: Map<string, SubagentRunChange<T>> | undefined,
): Map<string, T> {
  for (const [runId, { entry }] of changes ?? []) {
    if (entry) {
      runs.set(runId, entry);
    } else {
      runs.delete(runId);
    }
  }
  return runs;
}

export function retainUnpublishedSubagentChanges<T>(
  changes: Map<string, SubagentRunChange<T>> | undefined,
) {
  for (const [runId, change] of changes ?? []) {
    if (change.committed) {
      changes?.delete(runId);
    }
  }
  return changes?.size ? changes : undefined;
}

/** Selecting a read must not consume another database owner's publication. */
function selectSubagentCacheStateForRead<T extends SubagentRunReadRecord>(
  state: SubagentRunsCacheState<T>,
  context?: OpenClawStateWorkerContext,
): SubagentRunsCacheState<T> {
  const identity = state.retiredPublicationIdentity ?? state.admission?.identity;
  const matches = context
    ? !state.retiredPublicationIdentity &&
      matchesSubagentCacheAdmission(state.admission, context.admission) &&
      (state.sourceIdentity === undefined ||
        state.sourceIdentity === context.admission.identity.key)
    : !identity ||
      identity ===
        openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
          resolveOpenClawStateSqlitePath(),
        );
  return matches ? state : {};
}

export function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  { committed = true, databasePath }: SubagentRunPublication = {},
): void {
  let admission: OpenClawStateDatabaseReadAdmission | undefined;
  let retiredPublicationIdentity: DatabasePathIdentity | undefined;
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
    // Published full facts survive read retirement; this identity is provenance, not admission.
    retiredPublicationIdentity = expectDefined(
      openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
        databasePath ?? resolveOpenClawStateSqlitePath(),
      ),
      "retired subagent registry publication identity",
    );
  }
  const previous = retiredPublicationIdentity
    ? (cache.state.retiredPublicationIdentity ?? cache.state.admission?.identity) ===
      retiredPublicationIdentity
      ? cache.state
      : {}
    : !cache.state.retiredPublicationIdentity &&
        matchesSubagentCacheAdmission(cache.state.admission, admission) &&
        (cache.state.sourceIdentity === undefined ||
          cache.state.sourceIdentity === admission?.identity.key)
      ? cache.state
      : {};
  const owner = {
    admission,
    sourceIdentity: admission?.identity.key ?? retiredPublicationIdentity?.key,
    retiredPublicationIdentity,
  };
  const snapshot = previous.snapshot;
  if (!changedRunIds) {
    cache.state = {
      snapshot: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
      ...(!committed ? { replacementPending: true as const } : {}),
      ...owner,
    };
    return;
  }
  if (!snapshot) {
    // Until the first full read, named writes cannot account for durable-only rows.
    const changes = previous.changes ?? new Map<string, SubagentRunChange<T>>();
    for (const runId of changedRunIds) {
      const entry = runs.get(runId);
      changes.set(runId, { entry: entry ? cache.copy(entry) : undefined, committed });
    }
    cache.state = {
      changes,
      ...owner,
      pending: previous.pending,
    };
    return;
  }
  const lookup = previous.lookup;
  const runIdLookup = previous.runIdLookup;
  const changes = previous.changes ?? new Map<string, SubagentRunChange<T>>();
  // A failed projection/update cannot leave derived membership ahead of its Map.
  previous.lookup = undefined;
  previous.runIdLookup = undefined;
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.set(runId, cache.copy(entry));
    } else {
      snapshot.delete(runId);
    }
    if (!committed || previous.replacementPending) {
      changes.set(runId, { entry: snapshot.get(runId), committed });
    } else {
      changes.delete(runId);
    }
    lookup?.set(runId, snapshot.get(runId));
    runIdLookup?.set(runId, snapshot.get(runId));
  }
  cache.state = {
    snapshot,
    ...owner,
    changes: changes.size ? changes : undefined,
    ...(previous.replacementPending ? { replacementPending: true } : {}),
    ...(lookup ? { lookup } : {}),
    ...(runIdLookup ? { runIdLookup } : {}),
  };
}

export function getPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> | null {
  let admission: OpenClawStateDatabaseReadAdmission | undefined;
  if (!cache.load) {
    const context = captureOpenClawStateReadContext();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    admission = context.admission;
  } else {
    try {
      admission = cache.captureAdmission?.();
    } catch (error) {
      if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
        throw error;
      }
      const state = selectSubagentCacheStateForRead(cache.state);
      return applySubagentRunChanges(new Map(state.snapshot), state.changes);
    }
  }
  if (
    cache.state.retiredPublicationIdentity ||
    !matchesSubagentCacheAdmission(cache.state.admission, admission) ||
    (admission && cache.state.sourceIdentity !== admission.identity.key)
  ) {
    cache.state = { admission, sourceIdentity: admission?.identity.key };
    return null;
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
  cache.state = {
    snapshot: runs,
    changes: retainUnpublishedSubagentChanges(cache.state.changes),
    admission,
    sourceIdentity: admission?.identity.key,
  };
  return runs;
}

export function assertSubagentReadContext(context: OpenClawStateWorkerContext): void {
  getAsyncWorkSignal()?.throwIfAborted();
  context.maintenanceScope?.assertAdmission();
  context.admission.assertCurrent();
  const current = captureOpenClawStateReadContext();
  if (current.admission.identity.key !== context.admission.identity.key) {
    throw new Error("Subagent registry database changed during preparation");
  }
}

export function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    selectCached?: (lookup: SubagentSessionReadLookup) => readonly string[];
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
      const cachedRows =
        cached && scope?.selectCached
          ? indexedSnapshotRows(
              cached,
              scope.selectCached(
                expectDefined(getSessionListLookup(cache, cached), "subagent lookup"),
              ),
            )
          : cached?.values();
      const persisted = scope?.load
        ? (cachedRows ?? scope.load())
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
    const state = selectSubagentCacheStateForRead(cache.state);
    for (const [runId, { entry }] of state.changes ?? []) {
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
                    changes: retainUnpublishedSubagentChanges(cache.state.changes),
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
  return !state.retiredPublicationIdentity &&
    !getActiveOpenClawStateDatabaseReadSnapshot({
      path: context.admission.databasePath,
      env: context.environment,
    }) &&
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
  {
    context,
    fresh = false,
    runIds,
  }: { context?: OpenClawStateWorkerContext; fresh?: boolean; runIds?: ReadonlySet<string> } = {},
): Map<string, SubagentRunRecord> {
  const current = context && !fresh ? acceptedFullSnapshot(cache, context) : undefined;
  const merged = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of selectedEntries(current ?? persisted, runIds)) {
    if (matches(entry)) {
      merged.set(runId, current ? structuredClone(entry) : entry);
    }
  }
  const state = selectSubagentCacheStateForRead(cache.state, context);
  if (
    context &&
    !getActiveOpenClawStateDatabaseReadSnapshot({
      path: context.admission.databasePath,
      env: context.environment,
    }) &&
    state.sourceIdentity === context.admission.identity.key &&
    matchesSubagentCacheAdmission(state.admission, context.admission)
  ) {
    if (fresh && state.replacementPending) {
      for (const runId of merged.keys()) {
        if (!state.changes?.get(runId)?.committed) {
          merged.delete(runId);
        }
      }
      for (const [runId, entry] of selectedEntries(state.snapshot, runIds)) {
        if (!state.changes?.get(runId)?.committed && matches(entry)) {
          merged.set(runId, structuredClone(entry));
        }
      }
    }
    for (const [runId, { entry, committed }] of state.changes
      ? selectedEntries(state.changes, runIds)
      : []) {
      if (fresh && committed) {
        continue;
      }
      if (entry && matches(entry)) {
        merged.set(runId, structuredClone(entry));
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of selectedEntries(inMemoryRuns, runIds)) {
    if (matches(entry)) {
      merged.set(runId, entry);
    } else {
      merged.delete(runId);
    }
  }
  return merged;
}

function* selectedEntries<T>(
  rows: ReadonlyMap<string, T>,
  runIds?: ReadonlySet<string>,
): Iterable<[string, T]> {
  if (!runIds) {
    yield* rows;
    return;
  }
  for (const runId of runIds) {
    const entry = rows.get(runId);
    if (entry !== undefined) {
      yield [runId, entry];
    }
  }
}
