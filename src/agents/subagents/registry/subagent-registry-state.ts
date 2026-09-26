import {
  emitSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateWorkerContext,
  prepareOpenClawStateReadSource,
} from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRegistryChangesAsync,
  supersedePendingSubagentRegistryWrites,
  type SubagentRegistryWriteOptions,
} from "./subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  applySubagentRunChanges,
  assertSubagentReadContext,
  captureSubagentFactsAdmission,
  getSessionListLookup,
  getSubagentRunsSnapshot,
  indexedSnapshotRows,
  getPersistedSubagentRunsSnapshot,
  loadPersistedSubagentRunsForRead,
  mergeSelectedFullRuns,
  prepareSubagentRunsCache,
  readCompactSubagentRuns,
  rememberSubagentRunsSnapshot,
  retainUnpublishedSubagentChanges,
  shouldReadPersistedSubagentRuns,
  SubagentSessionListUnavailableError,
  type SubagentRunsCache,
  type SubagentRunPublication,
} from "./subagent-registry-read-cache.js";
import {
  prepareSubagentRunReadSnapshot,
  type PreparedSubagentRunsRead,
  type SubagentRunReadSelection,
} from "./subagent-registry-read-snapshot.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges live runs with retained SQLite rows under the process-local registry owner.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentMaintenanceRunsFromSqlite,
  loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  state: {},
  captureAdmission: captureSubagentFactsAdmission,
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  state: {},
  captureAdmission: captureSubagentFactsAdmission,
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};
const persistedSubagentMaintenanceRunsReadCache: SubagentRunsCache<SubagentRunMaintenanceRecord> = {
  state: {},
  load: () => loadSubagentMaintenanceRunsFromSqlite(),
  copy: projectSubagentRunForMaintenance,
  project: projectSubagentRunForMaintenance,
};

// Read caches deliberately advance on failed best-effort writes. Keep notification facts
// commit-owned so a successful retry still refreshes the parent, including after archive.
const committedSwarmNotifications = new Map<
  string,
  { event: SessionLifecycleEvent; signature: string }
>();

function swarmNotification(
  entry: SubagentRunRecord | undefined,
): { event: SessionLifecycleEvent; signature: string } | undefined {
  if (
    !entry?.collect ||
    !entry.swarmRequesterSessionKey ||
    !entry.requesterAgentId ||
    !entry.groupId
  ) {
    return undefined;
  }
  return {
    event: {
      sessionKey: entry.swarmRequesterSessionKey,
      agentId: entry.requesterAgentId,
      reason: "swarm",
      scope: "runtime",
    },
    // Compare the summary's raw inputs, never child results, labels or error text.
    signature: JSON.stringify([
      entry.swarmRequesterSessionKey,
      entry.requesterAgentId,
      entry.groupId,
      entry.createdAt,
      entry.childSessionKey,
      entry.execution.status,
      entry.collectorCompletion?.status,
    ]),
  };
}

function updateCommittedSwarmNotifications(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): SessionLifecycleEvent[] {
  const events = new Map<string, SessionLifecycleEvent>();
  const ids = changedRunIds ?? new Set([...committedSwarmNotifications.keys(), ...runs.keys()]);
  for (const runId of ids) {
    const previous = committedSwarmNotifications.get(runId);
    const next = swarmNotification(runs.get(runId));
    if (previous?.signature === next?.signature) {
      continue;
    }
    if (next) {
      committedSwarmNotifications.set(runId, next);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    for (const notification of [previous, next]) {
      if (notification) {
        const event = notification.event;
        events.set(JSON.stringify([event.sessionKey, event.agentId]), event);
      }
    }
  }
  return [...events.values()];
}

type SubagentRegistryPersistListener = (sessionKeys?: readonly (string | undefined)[]) => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(
  keys?: Array<string | undefined>,
  runIds?: readonly string[],
): void {
  publishSubagentRunChanges(keys, runIds);
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener(keys);
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Wake process-local readers after a registry mutation, even if persistence failed. */
export function onSubagentRegistryPersisted(listener: SubagentRegistryPersistListener): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  return () => {
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
  publication: SubagentRunPublication = {},
): Array<string | undefined> | undefined {
  const previous =
    persistedSubagentSessionListRunsReadCache.state.snapshot ??
    persistedSubagentRunsReadCache.state.snapshot;
  const keys =
    previous &&
    changedRunIds?.flatMap((runId) =>
      [previous.get(runId), runs.get(runId)].flatMap((run) => [
        run?.childSessionKey,
        run?.requesterSessionKey,
        run?.controllerSessionKey,
        run?.swarmRequesterSessionKey,
      ]),
    );
  for (const cache of [
    persistedSubagentRunsReadCache,
    persistedSubagentSessionListRunsReadCache,
    persistedSubagentMaintenanceRunsReadCache,
  ]) {
    rememberSubagentRunsSnapshot(cache, runs, changedRunIds, publication);
  }
  return keys;
}

/** Publishes registry rows already committed by a cross-owner shared-state transaction. */
export function publishSubagentRunsAfterAtomicStore(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  deferredObserverEvents: Array<() => void>,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  subagentRuns.settleCompletionAuthorities(runs, changedRunIds);
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = updateCommittedSwarmNotifications(runs, changedRunIds);
  deferredObserverEvents.push(() => {
    emitSubagentRegistryPersisted(keys, changedRunIds);
    events.forEach(emitSessionLifecycleEvent);
  });
}

/** Existing resident facts, fenced by the physical source rather than a publisher's scope. */
export function getSubagentSessionListReadSnapshotIdentity(): object | undefined {
  if (!shouldReadPersistedSubagentRuns()) {
    return subagentRuns;
  }
  try {
    return getPersistedSubagentRunsSnapshot(persistedSubagentSessionListRunsReadCache) ?? undefined;
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    return undefined;
  }
}

export type SubagentSessionListReadView = {
  snapshotIdentity(this: void): object | undefined;
  runs(this: void, runIds?: ReadonlySet<string>): Map<string, SubagentRunReadRecord>;
  prepare(this: void): Promise<void>;
};

/** A long-lived projection retains its source; registry publications still own the facts. */
export function createSubagentSessionListReadView(options: {
  env: NodeJS.ProcessEnv;
  path?: string;
}): SubagentSessionListReadView {
  const path = options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const source = prepareOpenClawStateReadSource({ path, env: options.env });
  const cache = persistedSubagentSessionListRunsReadCache;
  const readPersisted = shouldReadPersistedSubagentRuns();
  const matches = () => true;
  const prepare = (context: OpenClawStateWorkerContext) =>
    prepareSubagentRunsCache(cache, readCompactSubagentRuns, context);
  return {
    snapshotIdentity() {
      if (!readPersisted) {
        return subagentRuns;
      }
      try {
        return getPersistedSubagentRunsSnapshot(cache, source.current()) ?? undefined;
      } catch (error) {
        if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
          throw error;
        }
        return undefined;
      }
    },
    runs(runIds) {
      if (runIds) {
        const persisted = readPersisted
          ? getPersistedSubagentRunsSnapshot(cache, source.current())
          : undefined;
        const selected = new Map<string, SubagentRunReadRecord>();
        for (const runId of runIds) {
          const live = subagentRuns.get(runId);
          const entry = live ? cache.project(live) : persisted?.get(runId);
          if (entry) {
            selected.set(runId, entry);
          }
        }
        return selected;
      }
      return getSubagentRunsSnapshot(subagentRuns, cache, {
        context: readPersisted ? source.current() : undefined,
        matches,
      });
    },
    async prepare() {
      if (!readPersisted) {
        return;
      }
      if (getActiveOpenClawStateDatabaseReadSnapshot({ path, env: options.env })) {
        throw new Error("Resident subagent preparation cannot adopt a private database snapshot");
      }
      await source.withCurrent(prepare);
    },
  };
}

export async function prepareSubagentSessionListReadCache(): Promise<void> {
  if (!shouldReadPersistedSubagentRuns()) {
    return;
  }
  if (getActiveOpenClawStateDatabaseReadSnapshot()) {
    throw new Error("Resident subagent preparation cannot adopt a private database snapshot");
  }
  await prepareSubagentRunsCache(
    persistedSubagentSessionListRunsReadCache,
    readCompactSubagentRuns,
  );
}

/** History can omit retained child hints only after a failed query has settled cleanly. */
export async function prepareOptionalSubagentSessionListReadCache(): Promise<boolean> {
  if (!shouldReadPersistedSubagentRuns()) {
    return true;
  }
  const context = captureOpenClawStateWorkerContext();
  try {
    await prepareSubagentSessionListReadCache();
    assertSubagentReadContext(context);
    return true;
  } catch (error) {
    if (!(error instanceof SubagentSessionListUnavailableError)) {
      throw error;
    }
    assertSubagentReadContext(context);
    return false;
  }
}

export function clearSubagentRunsReadCacheForTest(): void {
  supersedePendingSubagentRegistryWrites();
  committedSwarmNotifications.clear();
  persistedSubagentRunsReadCache.state = {};
  persistedSubagentSessionListRunsReadCache.state = {};
  persistedSubagentMaintenanceRunsReadCache.state = {};
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  let committed = false;
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
    committed = true;
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  if (committed) {
    subagentRuns.settleCompletionAuthorities(runs, changedRunIds);
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds, { committed });
  const events = committed ? updateCommittedSwarmNotifications(runs, changedRunIds) : [];
  emitSubagentRegistryPersisted(keys, changedRunIds);
  events.forEach(emitSessionLifecycleEvent);
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function persistSubagentRunsToDiskAsyncOrThrow(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  options: SubagentRegistryWriteOptions,
): Promise<void> {
  return persistSubagentRegistryChangesAsync(runs, changedRunIds, options, (snapshot, runIds) => {
    options.onCommitted?.(runIds);
    subagentRuns.settleCompletionAuthorities(snapshot, runIds);
    const keys = rememberPersistedSubagentRunsSnapshot(snapshot, runIds, {
      databasePath: options.context.admission.databasePath,
    });
    const events = updateCommittedSwarmNotifications(snapshot, runIds);
    emitSubagentRegistryPersisted(keys, runIds);
    events.forEach(emitSessionLifecycleEvent);
  });
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  supersedePendingSubagentRegistryWrites();
  const keys = rememberPersistedSubagentRunsSnapshot(restored);
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    const notification = swarmNotification(entry);
    if (notification) {
      committedSwarmNotifications.set(runId, notification);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    subagentRuns.commitOwnership(entry);
    added += 1;
  }
  emitSubagentRegistryPersisted(keys);
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

/** All generations of exact children, sharing the existing snapshot and its publication-owned lookup. */
export function getSubagentSessionListRunsSnapshotForChildSessions(
  childSessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  const keys = new Set(childSessionKeys.map((key) => key.trim()).filter(Boolean));
  const selected = new Map<string, SubagentRunReadRecord>();
  if (keys.size === 0) {
    return selected;
  }
  const cache = persistedSubagentSessionListRunsReadCache;
  if (shouldReadPersistedSubagentRuns()) {
    const snapshot = loadPersistedSubagentRunsForRead(cache);
    const lookup = getSessionListLookup(cache, snapshot);
    for (const runId of lookup?.selectChildren(keys) ?? []) {
      // A live row can have moved out of a persisted child bucket.
      const persisted = snapshot.get(runId);
      const live = persisted && subagentRuns.get(persisted.runId);
      const entry = live ? cache.project(live) : persisted;
      if (entry && keys.has(entry.childSessionKey.trim())) {
        selected.set(entry.runId, entry);
      }
    }
  }
  for (const key of keys) {
    for (const entry of getSubagentRunsForChildSession(key)) {
      selected.set(entry.runId, cache.project(entry));
    }
  }
  return selected;
}

export function getSubagentMaintenanceRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunMaintenanceRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentMaintenanceRunsReadCache);
}

/** Hydrate selected payloads, then capture their current graph and raw owners in one frame. */
export async function withSubagentRunReadSnapshot<S extends SubagentRunReadSelection, T>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  select: (snapshot: Map<string, SubagentRunReadRecord>) => S,
  consume: (selection: S, runs: ReadonlyMap<string, SubagentRunRecord>) => T,
): Promise<T> {
  for (;;) {
    const prepared = await prepareSubagentRunReadSnapshot({
      inMemoryRuns,
      fullCache: persistedSubagentRunsReadCache,
      compactCache: persistedSubagentSessionListRunsReadCache,
      select,
    });
    const result = prepared.consume(consume);
    if (result.ready) {
      return result.value;
    }
  }
}

export async function prepareSubagentRunsSnapshotForRunIds(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
): Promise<PreparedSubagentRunsRead> {
  const requested = new Set(runIds.map((runId) => runId.trim()));
  const matches = (entry: SubagentRunReadRecord) =>
    requested.has(entry.runId) || Boolean(entry.swarmRunId && requested.has(entry.swarmRunId));
  const prepared = await prepareSubagentRunReadSnapshot({
    inMemoryRuns,
    fullCache: persistedSubagentRunsReadCache,
    compactCache: persistedSubagentSessionListRunsReadCache,
    requestedRunIds: requested,
    select: (snapshot) => ({
      runIds: [...snapshot.values()].filter(matches).map((entry) => entry.runId),
      sessionKeys: [],
    }),
  });
  return {
    consume(consume) {
      return prepared.consume((selection, runs) => {
        const selected = new Map<string, SubagentRunRecord>();
        for (const runId of selection.runIds) {
          const entry = runs.get(runId);
          if (entry) {
            selected.set(runId, entry);
          }
        }
        return consume(selected);
      });
    },
  };
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKeys?: readonly string[],
): Map<string, SubagentRunReadRecord> {
  if (controllerSessionKeys) {
    const keys = new Set(controllerSessionKeys.map((key) => key.trim()).filter(Boolean));
    if (keys.size === 0) {
      return new Map();
    }
    const cache = persistedSubagentSessionListRunsReadCache;
    const cached = shouldReadPersistedSubagentRuns()
      ? getPersistedSubagentRunsSnapshot(cache)
      : null;
    const lookup = cached ? getSessionListLookup(cache, cached) : undefined;
    if (!cached || !lookup) {
      if (!shouldReadPersistedSubagentRuns()) {
        return getSubagentRunsSnapshot(inMemoryRuns, cache, {
          matches: (entry) =>
            keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
        });
      }
      throw new Error("Subagent session-list facts must be prepared before synchronous reads");
    }
    return getSubagentRunsSnapshot(inMemoryRuns, cache, {
      fresh: true,
      load: () => indexedSnapshotRows(cached, lookup.selectControllers(keys)),
      matches: (entry) => keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
    });
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

function getSubagentSessionTreeSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
  cache: SubagentRunsCache<T>,
  load?: () => { sessionKeys: Set<string>; runs: Map<string, T>; complete: boolean },
): Map<string, T> {
  if (!sessionKeys.some((key) => key.trim())) {
    return new Map();
  }
  const cached = shouldReadPersistedSubagentRuns() ? getPersistedSubagentRunsSnapshot(cache) : null;
  const lookup = cached ? getSessionListLookup(cache, cached) : undefined;
  const indexed = lookup?.selectSessions(sessionKeys, inMemoryRuns.values());
  let selected =
    indexed?.sessionKeys ??
    collectSubagentSessionReadKeys(sessionKeys, cached?.values() ?? [], inMemoryRuns.values());
  return getSubagentRunsSnapshot(inMemoryRuns, cache, {
    // The loader owns cache selection so topology and metadata use the same source.
    fresh: true,
    // Descendant queries only inspect records, matching their unscoped snapshots.
    borrowPersisted: true,
    load: () => {
      if (cached) {
        return indexed ? indexedSnapshotRows(cached, indexed.cacheKeys) : cached.values();
      }
      if (!load) {
        throw new Error("Subagent session-list facts must be prepared before synchronous reads");
      }
      const snapshot = load();
      // A tree covering every physical row may populate the existing full cache.
      if (snapshot.complete) {
        applySubagentRunChanges(snapshot.runs, cache.state.changes);
        snapshot.sessionKeys = collectSubagentSessionReadKeys(
          sessionKeys,
          snapshot.runs.values(),
          inMemoryRuns.values(),
        );
        const admission = cache.captureAdmission?.();
        cache.state = {
          snapshot: snapshot.runs,
          changes: retainUnpublishedSubagentChanges(cache.state.changes),
          admission,
          sourceIdentity: admission?.identity.key,
        };
      }
      selected = snapshot.sessionKeys;
      return snapshot.runs.values();
    },
    matches: (entry) => selected.has(entry.childSessionKey.trim()),
  });
}

/** Exact rows share the owner snapshot while projecting only their complete requester trees. */
export function getSubagentSessionListRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentSessionListRunsReadCache,
  );
}

/** Settlement reads retain the canonical codec and raw local reservation ownership. */
export function getSubagentRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values()),
  );
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    selectCached: (lookup) => lookup.selectControllers(new Set([key])),
    load: () => loadSubagentRunsForControllerFromSqlite(key),
    matches: (entry) => (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = childSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    selectCached: (lookup) => lookup.selectChildren(new Set([key])),
    load: () => loadSubagentRunsForChildSessionFromSqlite(key),
    matches: (entry) => entry.childSessionKey === key,
  });
}

/** Merge fresh durable rows with this source's unpublished facts and current live owners. */
export function getPreparedSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
  persisted: readonly SubagentRunRecord[],
  context: OpenClawStateWorkerContext,
): Map<string, SubagentRunRecord> {
  return mergeSelectedFullRuns(
    persistedSubagentRunsReadCache,
    inMemoryRuns,
    new Map(persisted.map((entry) => [entry.runId, structuredClone(entry)])),
    (entry) => entry.childSessionKey === childSessionKey,
    { context, fresh: true },
  );
}
