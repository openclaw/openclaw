import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  acceptedFullSnapshot,
  assertSubagentReadContext,
  consumeSubagentRuns,
  getPersistedSubagentRunsSnapshot,
  mergeSelectedFullRuns,
  prepareSubagentRunsCache,
  readCompactSubagentRuns,
  readFullSubagentRuns,
  shouldReadPersistedSubagentRuns,
  type SubagentRunsCache,
} from "./subagent-registry-read-cache.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRunReadSelection = {
  runIds: readonly string[];
  sessionKeys: readonly string[];
};

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
}): Promise<PreparedSubagentRunRead<S>> {
  const { inMemoryRuns, fullCache, compactCache, select } = params;
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
        for (const readScope of scopes) {
          for (const [runId, entry] of await readFullSubagentRuns(context, readScope)) {
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
      const full = mergeSelectedFullRuns(
        fullCache,
        inMemoryRuns,
        preparedPayloads,
        matches,
        context,
      );
      for (const entry of full.values()) {
        snapshot.set(entry.runId, projectSubagentRunForSessionList(entry));
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
