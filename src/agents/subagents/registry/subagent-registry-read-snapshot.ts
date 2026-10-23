import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  getSubagentSessionReadLookup,
  immutableSubagentRunSessionList,
  isSubagentRunPayloadEvicted,
} from "./subagent-registry-memory.js";
import {
  acceptedFullSnapshot,
  assertSubagentReadContext,
  consumeSubagentRuns,
  getPersistedSubagentRunsSnapshot,
  getSessionListLookup,
  mergeSelectedFullRuns,
  prepareSubagentRunsCache,
  readCompactSubagentRuns,
  readFullSubagentRuns,
  shouldReadPersistedSubagentRuns,
  selectSubagentCacheStateForRead,
  type SubagentRunsCache,
} from "./subagent-registry-read-cache.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

export type SubagentRunReadSelection = {
  runIds: readonly string[];
  sessionKeys: readonly string[];
};

export type SubagentRunReadScope =
  | { runIds: ReadonlySet<string>; yieldedChildren?: boolean }
  | { childSessionKeys: readonly string[] }
  | { sessionKeys: readonly string[]; descendants: boolean }
  | "all";

type PreparedSubagentReadResult<T> = { ready: true; value: T } | { ready: false };

export type PreparedSubagentRunsRead = {
  consume<T>(
    consume: (runs: ReadonlyMap<string, SubagentRunRecord>) => T,
  ): PreparedSubagentReadResult<T>;
};

type PreparedSubagentRunRead<S> = {
  consume<T>(
    consume: (selection: S, runs: ReadonlyMap<string, SubagentRunRecord>) => T,
  ): PreparedSubagentReadResult<T>;
};

function selectionScope(selected: SubagentRunReadSelection) {
  const runIds = new Set(selected.runIds);
  const sessionKeys = new Set(selected.sessionKeys);
  return {
    runIds,
    sessionKeys,
    matches: (entry: SubagentRunReadRecord) =>
      runIds.has(entry.runId) ||
      sessionKeys.has(entry.requesterSessionKey.trim()) ||
      Boolean(entry.controllerSessionKey && sessionKeys.has(entry.controllerSessionKey.trim())),
  };
}

/** Merge only indexed scope members; live rows veto moved durable ownership. */
export function mergeSubagentRunReadScope(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  compactCache: SubagentRunsCache<SubagentRunReadRecord>,
  compact: Map<string, SubagentRunReadRecord>,
  readScope: SubagentRunReadScope,
): Map<string, SubagentRunReadRecord> {
  if (readScope !== "all") {
    const live = getSubagentSessionReadLookup(inMemoryRuns);
    const durable = getSessionListLookup(compactCache, compact);
    let liveKeys: string[];
    let persistedKeys: string[];
    if ("runIds" in readScope) {
      liveKeys = live.selectRunIds(readScope.runIds);
      persistedKeys = durable.selectRunIds(readScope.runIds, liveKeys);
      const yielded = readScope.yieldedChildren
        ? [...new Set([...persistedKeys, ...liveKeys])].flatMap((key) => {
            const entry = inMemoryRuns.get(key) ?? compact.get(key);
            return entry?.pauseReason === "sessions_yield" ? [entry.childSessionKey] : [];
          })
        : [];
      if (yielded.length > 0) {
        // A yielded run's announced children decide whether it is a leaf.
        const childLive = live.selectReadScope(yielded, durable, false, liveKeys);
        liveKeys = [...new Set([...liveKeys, ...childLive])];
        persistedKeys = [
          ...new Set([
            ...persistedKeys,
            ...durable.selectReadScope(yielded, live, false, liveKeys),
          ]),
        ];
      }
    } else if ("childSessionKeys" in readScope) {
      const keys = new Set(readScope.childSessionKeys.map((key) => key.trim()).filter(Boolean));
      liveKeys = live.selectChildren(keys);
      persistedKeys = durable.selectChildren(keys);
    } else {
      liveKeys = live.selectReadScope(readScope.sessionKeys, durable, readScope.descendants);
      persistedKeys = durable.selectReadScope(
        readScope.sessionKeys,
        live,
        readScope.descendants,
        liveKeys,
      );
    }
    const snapshot = new Map<string, SubagentRunReadRecord>();
    for (const key of new Set([...persistedKeys, ...liveKeys])) {
      const liveEntry = inMemoryRuns.get(key);
      const entry = liveEntry ? immutableSubagentRunSessionList(liveEntry) : compact.get(key);
      if (entry) {
        snapshot.set(key, entry);
      }
    }
    return snapshot;
  }
  const snapshot = new Map(compact);
  for (const [runId, entry] of inMemoryRuns) {
    snapshot.set(runId, immutableSubagentRunSessionList(entry));
  }
  return snapshot;
}

/** Prepare worker payloads; authority and publications are merged in the caller's consuming frame. */
export async function prepareSubagentRunReadSnapshot<S extends SubagentRunReadSelection>(params: {
  inMemoryRuns: Map<string, SubagentRunRecord>;
  fullCache: SubagentRunsCache<SubagentRunRecord>;
  compactCache: SubagentRunsCache<SubagentRunReadRecord>;
  select: (snapshot: Map<string, SubagentRunReadRecord>) => S;
  readScope: SubagentRunReadScope;
}): Promise<PreparedSubagentRunRead<S>> {
  const { inMemoryRuns, fullCache, compactCache, select, readScope } = params;
  const requestSignal = getAsyncWorkSignal();
  const privateSnapshot = getActiveOpenClawStateDatabaseReadSnapshot();
  const readPersisted = shouldReadPersistedSubagentRuns();
  let context = readPersisted ? captureOpenClawStateWorkerContext() : undefined;
  const assertCurrent = () => {
    requestSignal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    if (getActiveOpenClawStateDatabaseReadSnapshot() !== privateSnapshot) {
      throw new Error("Prepared subagent read left its database snapshot scope");
    }
    if (context) {
      assertSubagentReadContext(context);
    }
  };
  const withLiveFacts = (compact: Map<string, SubagentRunReadRecord>) =>
    mergeSubagentRunReadScope(inMemoryRuns, compactCache, compact, readScope);
  const compact = context
    ? await prepareSubagentRunsCache(compactCache, readCompactSubagentRuns)
    : new Map<string, SubagentRunReadRecord>();
  const initialSnapshot = withLiveFacts(compact);
  const selected = select(initialSnapshot);
  const scope = selectionScope(selected);
  const resident = context ? acceptedFullSnapshot(fullCache, context) : undefined;
  const preparedPayloads = mergeSelectedFullRuns(
    fullCache,
    inMemoryRuns,
    resident ?? new Map(),
    scope.matches,
    {
      context,
      runIds: scope.sessionKeys.size ? new Set(initialSnapshot.keys()) : scope.runIds,
    },
  );
  const residentPayloads = new Map(preparedPayloads);
  const evicted = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of preparedPayloads) {
    if (isSubagentRunPayloadEvicted(entry)) {
      evicted.set(runId, entry);
    }
  }
  if (evicted.size) {
    context ??= captureOpenClawStateWorkerContext();
  }
  if (context) {
    const scopes = [
      {
        kind: "ids" as const,
        runIds: [...new Set([...evicted.keys(), ...scope.runIds])].filter(
          (id) => !preparedPayloads.has(id) || evicted.has(id),
        ),
      },
      ...(!resident
        ? [...scope.sessionKeys].map((sessionKey) => ({ kind: "session" as const, sessionKey }))
        : []),
    ];
    for (const payloadScope of scopes) {
      for (const [runId, entry] of await readFullSubagentRuns(context, payloadScope)) {
        preparedPayloads.set(runId, entry);
      }
    }
  }
  for (const runId of evicted.keys()) {
    if (isSubagentRunPayloadEvicted(preparedPayloads.get(runId)!)) {
      throw new Error("Retained subagent payload is unavailable");
    }
  }
  const missingAtPreparation = new Set(
    selected.runIds.filter((runId) => !preparedPayloads.has(runId) && !inMemoryRuns.has(runId)),
  );
  return {
    consume(consume) {
      assertCurrent();
      const currentFull = context ? acceptedFullSnapshot(fullCache, context) : undefined;
      for (const [runId, entry] of residentPayloads) {
        const current = inMemoryRuns.get(runId) ?? currentFull?.get(runId);
        if (current && isSubagentRunPayloadEvicted(current) && current !== entry) {
          return { ready: false };
        }
      }
      const currentCompact =
        readPersisted && context && !privateSnapshot
          ? getPersistedSubagentRunsSnapshot(compactCache)
          : compact;
      if (!currentCompact || (currentCompact !== compact && !currentFull)) {
        return { ready: false };
      }
      const snapshot = withLiveFacts(currentCompact);
      const currentScope = selectionScope(select(snapshot));
      // Full metadata can reveal a yielded-child scope absent from compact facts.
      const matches = (entry: SubagentRunReadRecord) =>
        scope.matches(entry) || currentScope.matches(entry);
      const full = mergeSelectedFullRuns(fullCache, inMemoryRuns, preparedPayloads, matches, {
        context,
        runIds: new Set(snapshot.keys()),
      });
      for (const entry of full.values()) {
        if (inMemoryRuns.get(entry.runId) !== entry) {
          snapshot.set(entry.runId, immutableSubagentRunSessionList(entry));
        }
      }
      const current = select(snapshot);
      const needsHydration =
        current.sessionKeys.some((key) => !scope.sessionKeys.has(key)) ||
        current.runIds.some((runId) => {
          const entry = snapshot.get(runId);
          return entry && !matches(entry);
        });
      if (
        needsHydration ||
        current.runIds.some((runId) => {
          const entry = full.get(runId);
          return entry ? isSubagentRunPayloadEvicted(entry) : !missingAtPreparation.has(runId);
        })
      ) {
        return { ready: false };
      }
      const finalScope = selectionScope(current);
      for (const [runId, entry] of full) {
        if (!finalScope.matches(entry)) {
          full.delete(runId);
        }
      }
      return {
        ready: true,
        value: consumeSubagentRuns(full, (runs) => consume(current, runs)),
      };
    },
  };
}

export type PreparedSubagentSessionsRead = PreparedSubagentRunsRead;

/** The worker selects durable descendants; current liveness remains parent-owned. */
export async function prepareSubagentSessionRunReadSnapshot(params: {
  inMemoryRuns: Map<string, SubagentRunRecord>;
  fullCache: SubagentRunsCache<SubagentRunRecord>;
  sessionKeys: readonly string[];
  context?: OpenClawStateWorkerContext;
}): Promise<PreparedSubagentSessionsRead> {
  const { inMemoryRuns, fullCache } = params;
  const context = params.context ?? captureOpenClawStateWorkerContext();
  const signal = getAsyncWorkSignal();
  const roots = Object.freeze(
    [...new Set(params.sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted(),
  );
  const links = getSubagentSessionReadLookup(inMemoryRuns).captureTopology();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    {
      type: "subagents.runs",
      scope: { kind: "descendants", sessionKeys: roots, liveTopology: links },
    },
    { context, current: true },
  );
  if (reply && (reply.projection === "maintenance" || !reply.descendants)) {
    throw new Error("Subagent descendant read omitted its selection");
  }
  const persisted = reply?.runs ?? new Map<string, SubagentRunRecord>();
  const selected = reply?.descendants?.sessionKeys ?? collectSubagentSessionReadKeys(roots, links);
  return {
    consume(consume) {
      signal?.throwIfAborted();
      assertSubagentReadContext(context);
      // Registry writers publish live changes; raw outside writes during deletion are unsupported.
      const current = getSubagentSessionReadLookup(inMemoryRuns).captureTopology();
      const relevant = (values: typeof links) =>
        values.filter(
          (entry) =>
            selected.has(entry.childSessionKey.trim()) || selected.has(entry.requesterSessionKey),
        );
      if (
        current !== links &&
        JSON.stringify(relevant(current)) !== JSON.stringify(relevant(links))
      ) {
        return { ready: false };
      }
      const runs = mergeSelectedFullRuns(
        fullCache,
        inMemoryRuns,
        persisted,
        (entry) => selected.has(entry.childSessionKey.trim()),
        {
          context,
          freshPersisted: true,
          runIds: new Set([
            ...persisted.keys(),
            ...getSubagentSessionReadLookup(inMemoryRuns).selectChildren(selected),
          ]),
        },
      );
      return { ready: true, value: consumeSubagentRuns(runs, consume) };
    },
  };
}

/** Maintenance consumes current publications synchronously into its own protected-key snapshot. */
export async function prepareSubagentMaintenanceReadSnapshot(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<SubagentRunMaintenanceRecord>,
  options?: { live?: true },
) {
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  const signal = getAsyncWorkSignal();
  function* capture(persisted: ReadonlyMap<string, SubagentRunMaintenanceRecord>) {
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    if (context) {
      assertSubagentReadContext(context);
    }
    const state = context ? selectSubagentCacheStateForRead(cache.state, context) : {};
    for (const entry of (state.snapshot ?? persisted).values()) {
      if (!inMemoryRuns.has(entry.runId) && !state.changes?.has(entry.runId)) {
        yield entry;
      }
    }
    for (const [runId, { entry }] of state.changes ?? []) {
      if (entry && !inMemoryRuns.has(runId)) {
        yield entry;
      }
    }
    yield* inMemoryRuns.values();
  }
  if (!context) {
    return {
      capture: () => capture(new Map()),
    };
  }
  const persisted = await prepareSubagentRunsCache(
    cache,
    async () => {
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "subagents.runs", scope: { kind: "maintenance" } },
        { context, current: true, live: options?.live },
      );
      if (reply && reply.projection !== "maintenance") {
        throw new Error("Unexpected subagent maintenance read result");
      }
      return reply?.runs ?? new Map<string, SubagentRunMaintenanceRecord>();
    },
    context,
  );
  return {
    capture: () => capture(persisted),
  };
}
