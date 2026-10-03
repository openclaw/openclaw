import { isDeepStrictEqual } from "node:util";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import { getSubagentSessionReadLookup } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
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
  SubagentMaintenanceDurableBasis,
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
  const readCompact = async () => {
    const compact = context
      ? await prepareSubagentRunsCache(compactCache, readCompactSubagentRuns)
      : new Map<string, SubagentRunReadRecord>();
    assertCurrent();
    return compact;
  };
  const withLiveFacts = (compact: Map<string, SubagentRunReadRecord>) => {
    if (readScope !== "all") {
      let liveKeys: string[];
      let persistedKeys: string[];
      if ("runIds" in readScope) {
        liveKeys = getSubagentSessionReadLookup(inMemoryRuns).selectRunIds(readScope.runIds);
        persistedKeys = getSessionListLookup(compactCache, compact).selectRunIds(
          readScope.runIds,
          liveKeys,
        );
      } else {
        const live = getSubagentSessionReadLookup(inMemoryRuns);
        const durable = getSessionListLookup(compactCache, compact)!;
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
        const live = inMemoryRuns.get(key);
        const entry = live ? projectSubagentRunForSessionList(live) : compact.get(key);
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
  let compact = await readCompact();
  let selected = select(withLiveFacts(compact));
  let refreshedMissingRows = false;
  for (;;) {
    assertCurrent();
    const preparedCompact = compact;
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
    const captureFrame = (reselect: boolean) => {
      assertCurrent();
      const currentFull = context ? acceptedFullSnapshot(fullCache, context) : undefined;
      const currentCompact =
        context && !privateSnapshot
          ? getPersistedSubagentRunsSnapshot(compactCache)
          : preparedCompact;
      if (!currentCompact || (currentCompact !== preparedCompact && !currentFull)) {
        return undefined;
      }
      const snapshot = withLiveFacts(currentCompact);
      const currentScope = reselect ? selectionScope(select(snapshot)) : scope;
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
      const finalScope = selectionScope(current);
      for (const [runId, entry] of full) {
        if (!finalScope.matches(entry)) {
          full.delete(runId);
        }
      }
      return {
        compact: currentCompact,
        selection: current,
        runs: full,
        needsHydration,
        missingRunIds: current.runIds.filter((runId) => !full.has(runId)),
      };
    };
    const prepared = captureFrame(false);
    if (!prepared) {
      compact = await readCompact();
      selected = select(withLiveFacts(compact));
      continue;
    }
    if (prepared.needsHydration) {
      compact = prepared.compact;
      selected = prepared.selection;
      continue;
    }
    if (!refreshedMissingRows && prepared.missingRunIds.length > 0) {
      // One settled external replacement may precede its bridge publication.
      if (!privateSnapshot) {
        compactCache.state = {};
      }
      compact = await readCompact();
      selected = select(withLiveFacts(compact));
      refreshedMissingRows = true;
      continue;
    }
    const missingRunIds = new Set(prepared.missingRunIds);
    return {
      consume(consume) {
        const frame = captureFrame(true);
        if (
          !frame ||
          frame.needsHydration ||
          frame.missingRunIds.some((runId) => !missingRunIds.has(runId))
        ) {
          return { ready: false };
        }
        return {
          ready: true,
          value: consumeSubagentRuns(frame.runs, (runs) => consume(frame.selection, runs)),
        };
      },
    };
  }
}

export type PreparedSubagentSessionsRead = PreparedSubagentRunsRead & {
  readonly basis: SubagentRunsDurableBasis;
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
  const localRuns = () =>
    mergeSelectedFullRuns(fullCache, inMemoryRuns, new Map(), () => true, {
      context,
      freshPersisted: true,
    });
  const topology = () =>
    [...localRuns().values()]
      .map(({ childSessionKey, requesterSessionKey }) => ({ childSessionKey, requesterSessionKey }))
      .toSorted(
        (left, right) =>
          left.childSessionKey.localeCompare(right.childSessionKey) ||
          left.requesterSessionKey.localeCompare(right.requesterSessionKey),
      );
  let disposed = false;
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Prepared subagent descendant read was released");
    }
    signal?.throwIfAborted();
    assertSubagentReadContext(context);
  };
  let changed: (ids: readonly string[] | undefined) => void = () => {};
  const unsubscribe = subscribeSubagentRunChanges("projection", ({ runIds }) => changed(runIds));
  const dispose = () => {
    disposed = true;
    unsubscribe();
  };
  try {
    for (;;) {
      assertCurrent();
      const publications: Array<readonly string[] | undefined> = [];
      changed = (ids) => publications.push(ids);
      const links = topology();
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        {
          type: "subagents.runs",
          scope: { kind: "descendants", sessionKeys: roots, liveTopology: links },
        },
        { context, current: true },
      );
      assertCurrent();
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
      const physicalIds = new Set(reply?.descendantBasis?.runIds.map((id) => id.trim()));
      const selected =
        reply?.descendantBasis?.sessionKeys ?? collectSubagentSessionReadKeys(roots, links);
      const relevantEntry = (
        entry: Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey"> | undefined,
      ) =>
        Boolean(
          entry &&
          (selected.has(entry.childSessionKey.trim()) || selected.has(entry.requesterSessionKey)),
        );
      const relevantPublication = (ids: readonly string[] | undefined) =>
        ids === undefined ||
        ids.some(
          (id) =>
            physicalIds.has(id.trim()) ||
            relevantEntry(inMemoryRuns.get(id)) ||
            relevantEntry(fullCache.state.snapshot?.get(id)) ||
            relevantEntry(fullCache.state.changes?.get(id)?.entry),
        );
      const relevantLinks = (values: typeof links) => values.filter(relevantEntry);
      const expectedTopology = JSON.stringify(relevantLinks(links));
      if (
        publications.some(relevantPublication) ||
        expectedTopology !== JSON.stringify(relevantLinks(topology()))
      ) {
        continue;
      }
      let invalidated = false;
      changed = (ids) => {
        invalidated ||= relevantPublication(ids);
      };
      const basis: SubagentRunsDurableBasis = Object.freeze({
        databasePath: context.admission.databasePath,
        databaseIdentity: context.admission.identity.key,
        ...(context.admission.identity.birthtime
          ? { databaseBirthtime: context.admission.identity.birthtime }
          : {}),
        sessionKeys: roots,
        liveTopology: Object.freeze(links.map((link) => Object.freeze(link))),
        digest: reply?.descendantBasis?.digest ?? null,
      });
      return {
        basis,
        dispose,
        consume(consume) {
          assertCurrent();
          if (invalidated || expectedTopology !== JSON.stringify(relevantLinks(topology()))) {
            return { ready: false };
          }
          const runs = mergeSelectedFullRuns(
            fullCache,
            inMemoryRuns,
            persisted,
            (entry) => selected.has(entry.childSessionKey.trim()),
            { context, freshPersisted: true },
          );
          return { ready: true, value: consumeSubagentRuns(runs, consume) };
        },
      };
    }
  } catch (error) {
    dispose();
    throw error;
  }
}

export type PreparedSubagentMaintenanceRead = {
  readonly basis?: SubagentMaintenanceDurableBasis;
  capture(): ReadonlyMap<string, SubagentRunMaintenanceRecord>;
  dispose(): void;
};

/** Fresh physical maintenance facts combine with current published resident rows. */
export async function prepareSubagentMaintenanceReadSnapshot(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<SubagentRunMaintenanceRecord>,
): Promise<PreparedSubagentMaintenanceRead> {
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  const signal = getAsyncWorkSignal();
  let disposed = false;
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Prepared subagent maintenance read was released");
    }
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    if (context) {
      assertSubagentReadContext(context);
    }
  };
  const stateForRead = (): SubagentRunsCache<SubagentRunMaintenanceRecord>["state"] =>
    context ? selectSubagentCacheStateForRead(cache.state, context) : {};
  const capture = (persisted: ReadonlyMap<string, SubagentRunMaintenanceRecord>) => {
    assertCurrent();
    const runs = new Map(persisted);
    for (const [runId, entry] of inMemoryRuns) {
      runs.set(runId, cache.project(entry));
    }
    return runs;
  };
  if (!context) {
    return {
      capture: () => capture(new Map()),
      dispose: () => {
        disposed = true;
      },
    };
  }
  let invalidated = false;
  let published: (runIds: readonly string[] | undefined) => void = () => {
    invalidated = true;
  };
  const unsubscribe = subscribeSubagentRunChanges("projection", ({ runIds }) => published(runIds));
  const dispose = () => {
    disposed = true;
    unsubscribe();
  };
  try {
    for (;;) {
      assertCurrent();
      invalidated = false;
      const reply = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "subagents.runs", scope: { kind: "maintenance" } },
        { context, current: true },
      );
      assertCurrent();
      if (
        reply &&
        (!reply.ok || reply.type !== "subagents.runs" || reply.projection !== "maintenance")
      ) {
        throw new Error("Unexpected subagent maintenance read result");
      }
      if (invalidated) {
        continue;
      }
      const persisted = reply?.runs ?? new Map<string, SubagentRunMaintenanceRecord>();
      // Cache representation may change on publication; compare the actual compact rows.
      published = (runIds) => {
        const state = stateForRead();
        if (state.sourceIdentity !== context.admission.identity.key) {
          return;
        }
        if (runIds === undefined) {
          const replacement = state.snapshot;
          invalidated ||=
            !replacement ||
            replacement.size !== persisted.size ||
            [...persisted].some(
              ([runId, entry]) => !isDeepStrictEqual(entry, replacement.get(runId)),
            );
          return;
        }
        invalidated ||= runIds.some((runId) => {
          const change = state.changes?.get(runId);
          const entry = change ? change.entry : state.snapshot?.get(runId);
          return !isDeepStrictEqual(persisted.get(runId), entry);
        });
      };
      const basis: SubagentMaintenanceDurableBasis = Object.freeze({
        databasePath: context.admission.databasePath,
        databaseIdentity: context.admission.identity.key,
        ...(context.admission.identity.birthtime
          ? { databaseBirthtime: context.admission.identity.birthtime }
          : {}),
        digest: reply?.maintenanceDigest ?? null,
      });
      return {
        basis,
        dispose,
        capture() {
          assertCurrent();
          if (invalidated) {
            throw new Error("Subagent maintenance facts changed during preparation");
          }
          return capture(persisted);
        },
      };
    }
  } catch (error) {
    dispose();
    throw error;
  }
}
