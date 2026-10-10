import {
  emitSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  captureOpenClawStateWorkerContext,
  prepareOpenClawStateReadSource,
} from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  getSubagentRunsForChildSession,
  getSubagentSessionReadLookup,
  immutableSubagentRun,
  immutableSubagentRunSessionList,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  assertSubagentReadContext,
  consumeFreshSubagentRuns,
  getSessionListLookup,
  getSubagentRunsSnapshot,
  indexedSnapshotRows,
  getPersistedSubagentRunsSnapshot,
  loadPersistedSubagentRunsForRead,
  prepareSubagentRunsCache,
  readCompactSubagentRuns,
  rememberSubagentRunsSnapshot,
  shouldReadPersistedSubagentRuns,
  SubagentSessionListUnavailableError,
  type SubagentRunsCache,
} from "./subagent-registry-read-cache.js";
import {
  prepareSubagentRunReadSnapshot,
  prepareSubagentMaintenanceReadSnapshot,
  prepareSubagentSessionRunReadSnapshot,
  type PreparedSubagentRunsRead,
  type SubagentRunReadSelection,
  type SubagentRunReadScope,
} from "./subagent-registry-read-snapshot.js";
import { resolveControllerSessionKey } from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  state: {},
  retainRetiredPublications: true,
  copy: immutableSubagentRun,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  state: {},
  copy: immutableSubagentRunSessionList,
  project: projectSubagentRunForSessionList,
};

// Notification facts advance only with acknowledged row publications.
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
  changedRunIds: readonly string[] | undefined,
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

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
  databasePath?: string,
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
  for (const cache of [persistedSubagentRunsReadCache, persistedSubagentSessionListRunsReadCache]) {
    rememberSubagentRunsSnapshot(cache, runs, changedRunIds, databasePath);
  }
  return keys;
}

/** Publishes registry rows already committed by a cross-owner shared-state transaction. */
export function publishSubagentRunsAfterAtomicStore(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  databasePath?: string,
): () => void {
  subagentRuns.settleCompletionAuthorities(runs, changedRunIds);
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds, databasePath);
  const events = updateCommittedSwarmNotifications(runs, changedRunIds);
  return () => {
    publishSubagentRunChanges(keys, changedRunIds, "persistence");
    events.forEach(emitSessionLifecycleEvent);
  };
}

/** Hydration establishes a notification baseline before synchronous ownership observers run. */
export function rememberRestoredSubagentRunNotification(entry: SubagentRunRecord): void {
  const notification = swarmNotification(entry);
  if (notification) {
    committedSwarmNotifications.set(entry.runId, notification);
  } else {
    committedSwarmNotifications.delete(entry.runId);
  }
}

/** Existing resident facts, fenced by the physical source rather than a publisher's scope. */
export function getSubagentSessionListReadSnapshotIdentity(): object | undefined {
  if (!shouldReadPersistedSubagentRuns()) {
    return subagentRuns;
  }
  return getPersistedSubagentRunsSnapshot(persistedSubagentSessionListRunsReadCache) ?? undefined;
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
      return getPersistedSubagentRunsSnapshot(cache, source.current()) ?? undefined;
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
  committedSwarmNotifications.clear();
  persistedSubagentRunsReadCache.state = {};
  persistedSubagentSessionListRunsReadCache.state = {};
}

/** Consume a canonical worker read without crossing a cache-publication invalidation. */
export function consumeFreshSubagentRegistryRows<T>(
  context: OpenClawStateWorkerContext,
  consume: (runs: ReadonlyMap<string, SubagentRunRecord>) => T,
): Promise<T> {
  return consumeFreshSubagentRuns(persistedSubagentRunsReadCache, context, consume);
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
    for (const runId of lookup.selectChildren(keys)) {
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

export function prepareSubagentMaintenanceRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  options?: { live?: true },
) {
  return prepareSubagentMaintenanceReadSnapshot(
    inMemoryRuns,
    persistedSubagentRunsReadCache,
    options,
  );
}

/** Hydrate selected payloads, then capture their current graph and raw owners in one frame. */
export async function withSubagentRunReadSnapshot<S extends SubagentRunReadSelection, T>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  select: (snapshot: Map<string, SubagentRunReadRecord>) => S,
  consume: (selection: S, runs: ReadonlyMap<string, SubagentRunRecord>) => T,
  readScope: SubagentRunReadScope,
): Promise<T> {
  for (;;) {
    const prepared = await prepareSubagentRunReadSnapshot({
      inMemoryRuns,
      fullCache: persistedSubagentRunsReadCache,
      compactCache: persistedSubagentSessionListRunsReadCache,
      select,
      readScope,
    });
    const result = prepared.consume(consume);
    if (result.ready) {
      return result.value;
    }
  }
}

export function prepareSubagentRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
) {
  return prepareSubagentSessionRunReadSnapshot({
    inMemoryRuns,
    sessionKeys,
    fullCache: persistedSubagentRunsReadCache,
  });
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
    readScope: { runIds: requested },
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
    const matches = (entry: SubagentRunReadRecord) => keys.has(resolveControllerSessionKey(entry));
    const cache = persistedSubagentSessionListRunsReadCache;
    const cached = shouldReadPersistedSubagentRuns()
      ? getPersistedSubagentRunsSnapshot(cache)
      : null;
    if (!cached) {
      if (!shouldReadPersistedSubagentRuns()) {
        return getSubagentRunsSnapshot(inMemoryRuns, cache, {
          matches,
        });
      }
      throw new Error("Subagent session-list facts must be prepared before synchronous reads");
    }
    const lookup = getSessionListLookup(cache, cached);
    return getSubagentRunsSnapshot(inMemoryRuns, cache, {
      load: () => indexedSnapshotRows(cached, lookup.selectControllers(keys)),
      matches,
    });
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

/** Exact rows share the owner snapshot while projecting only their complete requester trees. */
export function getSubagentSessionListRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  if (!sessionKeys.some((key) => key.trim())) {
    return new Map();
  }
  const cache = persistedSubagentSessionListRunsReadCache;
  const cached = shouldReadPersistedSubagentRuns() ? getPersistedSubagentRunsSnapshot(cache) : null;
  const live = getSubagentSessionReadLookup(inMemoryRuns);
  const lookup = cached ? getSessionListLookup(cache, cached) : live;
  const indexed = lookup.selectSessions(sessionKeys, live);
  const persisted = cached ? indexedSnapshotRows(cached, indexed.cacheKeys) : [];
  return getSubagentRunsSnapshot(inMemoryRuns, cache, {
    // The loader owns cache selection so topology and metadata use the same source.
    load: () => {
      if (cached) {
        return persisted;
      }
      throw new Error("Subagent session-list facts must be prepared before synchronous reads");
    },
    // A live replacement can have moved out of a selected durable child bucket.
    liveRunIds: new Set([
      ...live.selectChildren(indexed.sessionKeys),
      ...persisted.map((entry) => entry.runId),
    ]),
    matches: (entry) => indexed.sessionKeys.has(entry.childSessionKey.trim()),
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
  childAgentId?: string,
): Promise<Map<string, SubagentRunRecord>> {
  const key = childSessionKey.trim();
  if (!key) {
    return Promise.resolve(new Map());
  }
  // Restore publications remain readable while their physical source drains.
  if (
    !shouldReadPersistedSubagentRuns() ||
    (!getActiveOpenClawStateDatabaseReadSnapshot() &&
      getPersistedSubagentRunsSnapshot(persistedSubagentRunsReadCache))
  ) {
    return Promise.resolve(
      getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
        selectCached: (lookup) => lookup.selectChildren(new Set([key])),
        matches: (entry) => matchesSubagentChildSessionOwner(entry, key, childAgentId),
      }),
    );
  }
  return withSubagentRunReadSnapshot(
    inMemoryRuns,
    (snapshot) => ({
      runIds: [...snapshot.values()]
        .filter((entry) => matchesSubagentChildSessionOwner(entry, key, childAgentId))
        .map((entry) => entry.runId),
      sessionKeys: [],
    }),
    (_selection, runs) => new Map(runs),
    { childSessionKeys: [key] },
  );
}
