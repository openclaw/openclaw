import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import { getSubagentSessionReadLookup } from "./subagent-registry-memory.js";
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
import type {
  SubagentRunReadRecord,
  SubagentRunsDurableBasis,
} from "./subagent-registry-read.types.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";

export type SubagentRunReadSelection = {
  runIds: readonly string[];
  sessionKeys: readonly string[];
};

export type SubagentRunReadScope =
  | { runIds: ReadonlySet<string> }
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
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
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
  const withLiveFacts = (compact: Map<string, SubagentRunReadRecord>) => {
    if (readScope !== "all") {
      const live = getSubagentSessionReadLookup(inMemoryRuns);
      const durable = getSessionListLookup(compactCache, compact);
      let liveKeys: string[];
      let persistedKeys: string[];
      if ("runIds" in readScope) {
        liveKeys = live.selectRunIds(readScope.runIds);
        persistedKeys = durable.selectRunIds(readScope.runIds, liveKeys);
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
        const entry = liveEntry ? projectSubagentRunForSessionList(liveEntry) : compact.get(key);
        if (entry) {
          snapshot.set(key, entry);
        }
      }
      return snapshot;
    }
    const snapshot = new Map(compact);
    for (const [runId, entry] of inMemoryRuns) {
      snapshot.set(runId, projectSubagentRunForSessionList(entry));
    }
    return snapshot;
  };
  const compact = context
    ? await prepareSubagentRunsCache(compactCache, readCompactSubagentRuns)
    : new Map<string, SubagentRunReadRecord>();
  const selected = select(withLiveFacts(compact));
  const scope = selectionScope(selected);
  // Keep durable payloads separate: a live-only row may disappear before consumption.
  let persisted = context ? acceptedFullSnapshot(fullCache, context) : undefined;
  if (!persisted) {
    persisted = new Map<string, SubagentRunRecord>();
    if (context) {
      const scopes = [
        { kind: "ids" as const, runIds: [...scope.runIds] },
        ...[...scope.sessionKeys].map((sessionKey) => ({ kind: "session" as const, sessionKey })),
      ];
      for (const payloadScope of scopes) {
        for (const [runId, entry] of await readFullSubagentRuns(context, payloadScope)) {
          persisted.set(runId, entry);
        }
      }
    }
  }
  const preparedPayloads = persisted;
  const missingAtPreparation = new Set(
    selected.runIds.filter((runId) => !preparedPayloads.has(runId) && !inMemoryRuns.has(runId)),
  );
  return {
    consume(consume) {
      assertCurrent();
      const currentFull = context ? acceptedFullSnapshot(fullCache, context) : undefined;
      const currentCompact =
        context && !privateSnapshot ? getPersistedSubagentRunsSnapshot(compactCache) : compact;
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
          snapshot.set(entry.runId, projectSubagentRunForSessionList(entry));
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
        current.runIds.some((runId) => !full.has(runId) && !missingAtPreparation.has(runId))
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

export type PreparedSubagentSessionsRead = PreparedSubagentRunsRead & {
  readonly basis: SubagentRunsDurableBasis;
  // The protected cron deletion adapter still calls this resource-shaped API.
  dispose(): void;
};

/** The durable basis is fresh worker evidence; live liveness remains parent-owned. */
export async function prepareSubagentSessionRunReadSnapshot(params: {
  inMemoryRuns: Map<string, SubagentRunRecord>;
  fullCache: SubagentRunsCache<SubagentRunRecord>;
  sessionKeys: readonly string[];
}): Promise<PreparedSubagentSessionsRead> {
  const { inMemoryRuns, fullCache } = params;
  const context = captureOpenClawStateWorkerContext();
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
  if (
    reply &&
    (!reply.ok ||
      reply.type !== "subagents.runs" ||
      reply.projection === "maintenance" ||
      !reply.descendantBasis)
  ) {
    throw new Error("Subagent descendant read omitted its durable basis");
  }
  const persisted = reply?.runs ?? new Map<string, SubagentRunRecord>();
  const selected =
    reply?.descendantBasis?.sessionKeys ?? collectSubagentSessionReadKeys(roots, links);
  const basis: SubagentRunsDurableBasis = Object.freeze({
    databasePath: context.admission.databasePath,
    databaseIdentity: context.admission.identity.key,
    ...(context.admission.identity.birthtime
      ? { databaseBirthtime: context.admission.identity.birthtime }
      : {}),
    sessionKeys: roots,
    liveTopology: links,
    digest: reply?.descendantBasis?.digest ?? null,
  });
  return {
    basis,
    dispose() {},
    consume(consume) {
      signal?.throwIfAborted();
      assertSubagentReadContext(context);
      // A changed live tree needs a new selection; durable changes are checked at deletion.
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

export type PreparedSubagentMaintenanceRead = {
  capture(): ReadonlyMap<string, SubagentRunMaintenanceRecord>;
};

/** Fresh physical maintenance facts combine with current published resident rows. */
export async function prepareSubagentMaintenanceReadSnapshot(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<SubagentRunRecord>,
  options?: { live?: true },
): Promise<PreparedSubagentMaintenanceRead> {
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    if (context) {
      assertSubagentReadContext(context);
    }
  };
  const capture = (persisted: ReadonlyMap<string, SubagentRunMaintenanceRecord>) => {
    assertCurrent();
    const state: SubagentRunsCache<SubagentRunRecord>["state"] = context
      ? selectSubagentCacheStateForRead(cache.state, context)
      : {};
    const runs = new Map<string, SubagentRunMaintenanceRecord>(state.snapshot ?? persisted);
    for (const [runId, { entry }] of state.changes ?? []) {
      if (entry) {
        runs.set(runId, entry);
      } else {
        runs.delete(runId);
      }
    }
    for (const [runId, entry] of inMemoryRuns) {
      runs.set(runId, entry);
    }
    return runs;
  };
  if (!context) {
    return {
      capture: () => capture(new Map()),
    };
  }
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.runs", scope: { kind: "maintenance" } },
    { context, current: true, live: options?.live },
  );
  if (
    reply &&
    (!reply.ok || reply.type !== "subagents.runs" || reply.projection !== "maintenance")
  ) {
    throw new Error("Unexpected subagent maintenance read result");
  }
  const persisted = reply?.runs ?? new Map<string, SubagentRunMaintenanceRecord>();
  return {
    capture() {
      // The owner publishes committed changes before the final maintenance grant.
      return capture(persisted);
    },
  };
}
