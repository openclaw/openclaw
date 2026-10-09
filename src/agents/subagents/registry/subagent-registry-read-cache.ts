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
import type { OpenClawStateReadCommand } from "../../../state/openclaw-state-read.types.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
  type OpenClawStateReadContext,
} from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../../state/openclaw-state-worker-error.js";
import { freezeSubagentRunReadRecord, immutableSubagentRun } from "./subagent-registry-memory.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { rememberSubagentRunVersion } from "./subagent-registry.store.codec.js";
import { readAllSubagentRunsInWorker } from "./subagent-registry.store.read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

type SubagentRunChange<T> = { entry: T | undefined };

type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | {
      snapshot: Map<string, T>;
      lookup?: SubagentSessionReadLookup;
      changes?: never;
    }
  | {
      snapshot?: undefined;
      lookup?: never;
      changes?: Map<string, SubagentRunChange<T>>;
    }
) & {
  admission?: OpenClawStateDatabaseReadAdmission;
  sourceIdentity?: string;
  retiredPublicationIdentity?: DatabasePathIdentity;
  pending?: {
    promise: Promise<void>;
    ownerAbortSignal?: AbortSignal;
    cleanCancellation?: boolean;
    committedRevision?: number;
  };
};

export type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  state: SubagentRunsCacheState<T>;
  retainRetiredPublications?: boolean;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

export function getSessionListLookup<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  snapshot: Map<string, T>,
): SubagentSessionReadLookup {
  const state = cache.state;
  if (state.snapshot !== snapshot) {
    return new SubagentSessionReadLookup(snapshot);
  }
  return (state.lookup ??= new SubagentSessionReadLookup(snapshot));
}

export function indexedSnapshotRows<T>(snapshot: Map<string, T>, keys: readonly string[]): T[] {
  return keys.map((key) => expectDefined(snapshot.get(key), "indexed subagent cache entry"));
}

export function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function captureSubagentFactsAdmission(databasePath = resolveOpenClawStateSqlitePath()) {
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

function setOrDeleteRun<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  runId: string,
  entry: T | undefined,
): void {
  if (entry) {
    runs.set(runId, entry);
  } else {
    runs.delete(runId);
  }
}

function applySubagentRunChanges<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  changes: Map<string, SubagentRunChange<T>> | undefined,
): Map<string, T> {
  for (const [runId, { entry }] of changes ?? []) {
    setOrDeleteRun(runs, runId, entry);
  }
  return runs;
}

/** Selecting a read must not consume another database owner's publication. */
export function selectSubagentCacheStateForRead<T extends SubagentRunReadRecord>(
  state: SubagentRunsCacheState<T>,
  context?: Pick<OpenClawStateReadContext, "admission">,
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
  databasePath?: string,
): void {
  let admission: OpenClawStateDatabaseReadAdmission | undefined;
  let retiredPublicationIdentity: DatabasePathIdentity | undefined;
  try {
    admission = captureSubagentFactsAdmission(databasePath);
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    // Read retirement cannot turn committed publication into a write failure.
    if (!cache.retainRetiredPublications) {
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
    // Publication replaces facts, not custody of an accepted read and its cleanup.
    pending: previous.pending,
  };
  if (previous.pending?.committedRevision !== undefined) {
    previous.pending.committedRevision += 1;
  }
  const snapshot = previous.snapshot;
  if (!changedRunIds) {
    cache.state = {
      snapshot: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
      ...owner,
    };
    return;
  }
  if (!snapshot) {
    // Until the first full read, named writes cannot account for durable-only rows.
    const changes = previous.changes ?? new Map<string, SubagentRunChange<T>>();
    for (const runId of changedRunIds) {
      const entry = runs.get(runId);
      changes.set(runId, { entry: entry ? cache.copy(entry) : undefined });
    }
    cache.state = {
      changes,
      ...owner,
    };
    return;
  }
  const lookup = previous.lookup;
  // A failed projection/update cannot leave derived membership ahead of its Map.
  previous.lookup = undefined;
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    setOrDeleteRun(snapshot, runId, entry ? cache.copy(entry) : undefined);
    lookup?.set(runId, snapshot.get(runId));
  }
  cache.state = {
    snapshot,
    ...owner,
    ...(lookup ? { lookup } : {}),
  };
}

export function getPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  prepared?: OpenClawStateReadContext,
): Map<string, T> | null {
  let admission: OpenClawStateDatabaseReadAdmission | undefined;
  if (!cache.retainRetiredPublications) {
    const context = prepared ?? captureOpenClawStateReadContext();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    admission = context.admission;
  } else {
    try {
      admission = captureSubagentFactsAdmission();
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
    if (!prepared) {
      cache.state = { admission, sourceIdentity: admission?.identity.key };
    }
    return null;
  }
  return cache.state.pending ? null : (cache.state.snapshot ?? null);
}

export function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  prepared?: OpenClawStateReadContext,
): Map<string, T> {
  const cached = getPersistedSubagentRunsSnapshot(cache, prepared);
  if (cached) {
    return cached;
  }
  throw new Error("Subagent registry facts must be prepared before synchronous reads");
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
    context?: OpenClawStateReadContext;
    load?: () => Iterable<T>;
    selectCached?: (lookup: SubagentSessionReadLookup) => readonly string[];
    liveRunIds?: ReadonlySet<string>;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
): Map<string, T> {
  const merged = new Map<string, T>();
  if (shouldReadPersistedSubagentRuns()) {
    const cached = loadPersistedSubagentRunsForRead(cache, scope?.context);
    const persisted = scope?.load
      ? scope.load()
      : scope?.selectCached
        ? indexedSnapshotRows(cached, scope.selectCached(getSessionListLookup(cache, cached)))
        : cached.values();
    for (const entry of persisted) {
      if (!scope || scope.matches(entry)) {
        merged.set(entry.runId, entry);
      }
    }
  }
  if (shouldReadPersistedSubagentRuns()) {
    const state = selectSubagentCacheStateForRead(cache.state, scope?.context);
    for (const [runId, { entry }] of state.changes ?? []) {
      setOrDeleteRun(merged, runId, entry && (!scope || scope.matches(entry)) ? entry : undefined);
    }
  }
  for (const [runId, entry] of scope?.liveRunIds
    ? selectedEntries(inMemoryRuns, scope.liveRunIds)
    : inMemoryRuns) {
    // Live memory wins even when a run moved out of the persisted scope.
    setOrDeleteRun(
      merged,
      runId,
      !scope || scope.matches(entry) ? cache.project(entry) : undefined,
    );
  }
  return merged;
}

export class SubagentSessionListUnavailableError extends Error {}

export async function readCompactSubagentRuns(context: OpenClawStateWorkerContext) {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.sessionList" },
    { context },
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
  reply.runs.forEach(freezeSubagentRunReadRecord);
  return reply.runs;
}

export async function readFullSubagentRuns(
  context: OpenClawStateWorkerContext,
  scope: Extract<OpenClawStateReadCommand, { type: "subagents.runs" }>["scope"],
  options: { current?: boolean } = {},
) {
  if (scope.kind === "ids" && scope.runIds.length === 0) {
    assertSubagentReadContext(context);
    return new Map<string, SubagentRunRecord>();
  }
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.runs", scope },
    options.current ? { context, current: true } : undefined,
  );
  assertSubagentReadContext(context);
  if (!reply) {
    return new Map<string, SubagentRunRecord>();
  }
  if (!reply.ok || reply.type !== "subagents.runs" || reply.projection === "maintenance") {
    throw new Error("Unexpected subagent registry read result");
  }
  for (const [runId, entry] of reply.runs) {
    const version = reply.versions?.get(runId);
    if (version) {
      rememberSubagentRunVersion(entry, version);
    }
    immutableSubagentRun(entry);
  }
  return reply.runs;
}

export async function prepareSubagentRunsCache<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  load: (context: OpenClawStateWorkerContext) => Promise<Map<string, T>>,
  prepared?: OpenClawStateWorkerContext,
): Promise<Map<string, T>> {
  const context = prepared ?? captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    if (!prepared) {
      assertSubagentReadContext(context);
      return;
    }
    getAsyncWorkSignal()?.throwIfAborted();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  assertCurrent();
  if (
    getActiveOpenClawStateDatabaseReadSnapshot({
      path: context.admission.databasePath,
      env: context.environment,
    })
  ) {
    // Private snapshot bytes never become canonical resident facts.
    const runs = await load(context);
    assertCurrent();
    return runs;
  }
  const callerAbortSignal = getAsyncWorkSignal();
  let retriedCanceledFill = false;
  while (true) {
    assertCurrent();
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
    if (state.snapshot && !state.pending) {
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
            assertCurrent();
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
          // A newer full publication wins, but its readers still join this fill.
          if (cache.state.pending === fill && !cache.state.snapshot) {
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
      assertCurrent();
      retriedCanceledFill = true;
    } finally {
      if (cache.state.pending === fill) {
        cache.state.pending = undefined;
      }
    }
    if (
      prepared &&
      cache.state.sourceIdentity !== undefined &&
      cache.state.sourceIdentity !== context.admission.identity.key
    ) {
      throw new Error("Subagent registry database changed during preparation");
    }
  }
}

/** Restore consumes durable rows before another host publication can overtake the accepted read. */
export async function consumeFreshSubagentRuns<T>(
  cache: SubagentRunsCache<SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
  consume: (runs: Map<string, SubagentRunRecord>) => T,
): Promise<T> {
  assertSubagentReadContext(context);
  while (cache.state.pending) {
    await cache.state.pending.promise;
    assertSubagentReadContext(context);
  }
  const previous = selectSubagentCacheStateForRead(cache.state, context);
  const state = {
    ...previous,
    admission: captureSubagentFactsAdmission(context.admission.databasePath),
    sourceIdentity: context.admission.identity.key,
  };
  cache.state = state;
  let result: T;
  const fill: NonNullable<SubagentRunsCacheState<SubagentRunRecord>["pending"]> = {
    committedRevision: 0,
    promise: Promise.resolve().then(async () => {
      while (true) {
        assertSubagentReadContext(context);
        const revision = fill.committedRevision;
        const runs = await readAllSubagentRunsInWorker(context);
        assertSubagentReadContext(context);
        if (cache.state.pending !== fill) {
          throw new Error("Subagent restore lost its accepted read owner");
        }
        if (revision !== fill.committedRevision) {
          continue;
        }
        // A committed deletion invalidates the read above. Consume and publish
        // without another asynchronous boundary.
        result = consumeSubagentRuns(runs, () => consume(runs));
        return;
      }
    }),
  };
  state.pending = fill;
  try {
    await fill.promise;
    return result!;
  } finally {
    if (cache.state.pending === fill) {
      cache.state.pending = undefined;
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
    runIds,
    freshPersisted = false,
  }: {
    context?: OpenClawStateWorkerContext;
    runIds?: ReadonlySet<string>;
    freshPersisted?: boolean;
  } = {},
): Map<string, SubagentRunRecord> {
  const current = context && !freshPersisted ? acceptedFullSnapshot(cache, context) : undefined;
  const merged = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of selectedEntries(current ?? persisted, runIds)) {
    if (matches(entry)) {
      merged.set(runId, entry);
    }
  }
  const state = selectSubagentCacheStateForRead(cache.state, context);
  if (
    context &&
    !freshPersisted &&
    !getActiveOpenClawStateDatabaseReadSnapshot({
      path: context.admission.databasePath,
      env: context.environment,
    }) &&
    state.sourceIdentity === context.admission.identity.key &&
    matchesSubagentCacheAdmission(state.admission, context.admission)
  ) {
    for (const [runId, { entry }] of state.changes ? selectedEntries(state.changes, runIds) : []) {
      setOrDeleteRun(merged, runId, entry && matches(entry) ? entry : undefined);
    }
  }
  for (const [runId, entry] of selectedEntries(inMemoryRuns, runIds)) {
    setOrDeleteRun(merged, runId, matches(entry) ? entry : undefined);
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
