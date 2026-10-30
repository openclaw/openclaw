import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listLiveAgentRunIds } from "../../../infra/agent-run-registry.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { listSwarmRunReservationIds } from "../swarm/swarm-scheduler.js";
import {
  matchesSubagentChildSessionIdentity,
  resolveRecordedRequester,
} from "./subagent-child-owner-match.js";
import {
  getRecordedSubagentChildAuthority,
  getSubagentChildSessionCandidates,
  getSubagentRunsForChildSession,
  getSubagentSessionReadLookup,
  immutableSubagentRunSessionList,
  subagentRuns,
} from "./subagent-registry-memory.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  getLatestSubagentRunForChild,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  copySubagentRunRuntimeOwner,
  latestSubagentRun,
} from "./subagent-run-generation.js";
import { isSubagentRunLive, isSubagentRunQueued } from "./subagent-run-liveness.js";
export { isSubagentRunLive, isSubagentRunQueued } from "./subagent-run-liveness.js";

export type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunPausedForContinuation,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export type SubagentRootRequester = {
  sessionKey: string;
  agentId?: string;
  storePath?: string;
};

/** Shutdown follows the live registry's requester links, never persisted recovery claims. */
export function resolveRootSubagentRequester(
  sessionKey: string,
  agentId?: string,
): SubagentRootRequester {
  let root: SubagentRootRequester = { sessionKey, agentId };
  const visited = new Set<string>();
  for (;;) {
    const identity = JSON.stringify([root.agentId, root.sessionKey]);
    if (visited.has(identity)) {
      return root;
    }
    visited.add(identity);
    const entry = latestSubagentRun(getSubagentRunsForChildSession(root.sessionKey, root.agentId));
    if (!entry) {
      return root;
    }
    root = {
      sessionKey: entry.requesterSessionKey,
      agentId: resolveRecordedRequester(entry),
      storePath: entry.requesterStorePath,
    };
  }
}

export function listLiveSubagentRootSessions(): SubagentRootRequester[] {
  const roots = new Map<string, SubagentRootRequester>();
  for (const runId of listLiveAgentRunIds()) {
    const entry = subagentRuns.get(runId);
    if (!entry || !isSubagentRunLive(entry)) {
      continue;
    }
    const root = resolveRootSubagentRequester(entry.childSessionKey, entry.childAgentId);
    roots.set(JSON.stringify([root.agentId, root.storePath, root.sessionKey]), root);
  }
  return [...roots.values()];
}

/** Resolve live owners through the existing aliases without scanning retained history. */
export function listActiveSubagentSessionKeys(): string[] {
  const runIds = new Set([...listLiveAgentRunIds(), ...listSwarmRunReservationIds()]);
  const sessionKeys = new Set<string>();
  for (const runId of getSubagentSessionReadLookup(subagentRuns).selectRunIds(runIds)) {
    const entry = subagentRuns.get(runId);
    if (entry && (isSubagentRunLive(entry) || isSubagentRunQueued(entry))) {
      sessionKeys.add(entry.childSessionKey);
    }
  }
  return [...sessionKeys];
}

/** Builds the session-list index without hydrating full retained registry payloads. */
export function buildSubagentSessionListReadIndex(
  now = Date.now(),
  sessionKeys?: readonly string[],
  preparedRuns?: Map<string, SubagentRunReadRecord>,
): SubagentRunReadIndex<SubagentRunReadRecord> {
  const runs =
    preparedRuns ??
    (sessionKeys
      ? getSubagentSessionListRunsSnapshotForSessions(subagentRuns, sessionKeys)
      : getSubagentSessionListRunsSnapshotForRead(subagentRuns));
  // Liveness copies carry runtime ownership; shared display facts must never acquire it.
  return buildSubagentRunReadIndexFromRuns({
    runs,
    inMemoryRuns: sessionKeys
      ? [...runs.keys()].flatMap((runId) => {
          const entry = subagentRuns.get(runId);
          return entry
            ? [
                copySubagentRunRuntimeOwner(
                  entry,
                  Object.freeze({ ...immutableSubagentRunSessionList(entry) }),
                ),
              ]
            : [];
        })
      : Array.from(subagentRuns.values(), (entry) =>
          copySubagentRunRuntimeOwner(
            entry,
            Object.freeze({ ...immutableSubagentRunSessionList(entry) }),
          ),
        ),
    now,
  });
}

/** Direct-child discovery needs only its controllers, without building global topology. */
export function listSubagentSessionListRunsForControllers(
  controllerSessionKeys: readonly string[],
): SubagentRunReadRecord[] {
  const runs = getSubagentSessionListRunsSnapshotForRead(subagentRuns, controllerSessionKeys);
  return controllerSessionKeys.flatMap((key) => listRunsForControllerFromRuns(runs, key));
}

export function buildLatestSubagentSessionListReadIndex(
  childSessionKeys: readonly string[],
): LatestSubagentRunReadIndex<SubagentRunReadRecord> {
  return buildLatestSubagentRunReadIndexFromRuns(
    getSubagentSessionListRunsSnapshotForChildSessions(childSessionKeys),
  );
}

/** Capacity reads retain active-first selection without hydrating child payloads. */
export function getSubagentSessionListRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunReadRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentSessionListRunsSnapshotForChildSessions([childSessionKey]),
    childSessionKey,
    undefined,
    subagentRuns,
  );
}

export async function countPendingDescendantRuns(
  rootSessionKey: string,
  assertCurrent: () => void,
): Promise<number> {
  assertCurrent();
  await prepareSubagentSessionListReadCache();
  assertCurrent();
  return buildSubagentSessionListReadIndex(Date.now(), [rootSessionKey]).countPendingDescendantRuns(
    rootSessionKey,
  );
}

export async function resolveRequesterForChildSession(
  childSessionKey: string,
  childAgentId?: string,
): Promise<{
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null> {
  const resolved = getLatestSubagentRunForChild(
    await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    { childSessionKey, childAgentId },
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterAgentId: resolved.requesterAgentId,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

export async function shouldIgnorePostCompletionAnnounceForSession(
  childSessionKey: string,
  childAgentId?: string,
): Promise<boolean> {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    childSessionKey,
    childAgentId,
  );
}

/** True when the process-local registry still owns an active run for the child session. */
export function isSubagentSessionRunActive(
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  // Liveness is mutation ownership, so a persisted snapshot must not outvote the raw live map.
  return isSubagentRunLive(
    getLatestLiveSubagentRunByChildSessionKey(childSessionKey, undefined, childAgentId),
  );
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: Parameters<typeof listRunsForRequesterFromRuns>[2],
): SubagentRunRecord[] {
  // Request-run lifetime scoping must observe the raw live map, including rows not persisted yet.
  const lookup = getSubagentSessionReadLookup(subagentRuns);
  return listRunsForRequesterFromRuns(
    subagentRuns,
    requesterSessionKey,
    options,
    lookup
      .selectReadScope([requesterSessionKey], lookup, false)
      .map((runId) => subagentRuns.get(runId)!),
  );
}

export async function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
  childAgentId?: string,
): Promise<SubagentRunRecord | null> {
  return (
    getLatestSubagentRunForChild(
      await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
      { childSessionKey, childAgentId },
    ) ?? null
  );
}

/**
 * Returns the authoritative process-local run for mutation ownership checks.
 *
 * `matches` restricts the search to a row class the caller owns; see
 * `getLatestSubagentRunByChildSessionKeyFromRuns`.
 */
export function getLatestLiveSubagentRunByChildSessionKey(
  childSessionKey: string,
  matches?: (entry: SubagentRunRecord) => boolean,
  childAgentId?: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  // The live index owns child/agent matching; retained snapshots cannot confer custody.
  return latestSubagentRun(getSubagentRunsForChildSession(key, childAgentId), matches) ?? null;
}

const qualifiedChildKey = /^agent:/i;

/** Read registry-owned buckets directly; executor and reservation authority stays live. */
export function getSubagentChildControllerSessionKey(
  childSessionKey: string,
  session: { sessionId?: string; lifecycleRevision?: string },
): string | undefined {
  const key = childSessionKey.trim();
  if (!qualifiedChildKey.test(key)) {
    return undefined;
  }
  const candidates = getSubagentChildSessionCandidates(key);
  let latest: SubagentRunRecord | undefined;
  let index = 0;
  while (index < candidates.length) {
    const candidate = candidates[index++]!;
    if (
      (isSubagentRunLive(candidate) || isSubagentRunQueued(candidate)) &&
      getRecordedSubagentChildAuthority(candidate).status !== "mismatch" &&
      matchesSubagentChildSessionIdentity(candidate, session) &&
      (!latest || compareSubagentRunGeneration(candidate, latest) > 0)
    ) {
      latest = candidate;
    }
  }
  return (
    normalizeOptionalString(latest?.controllerSessionKey) ??
    normalizeOptionalString(latest?.requesterSessionKey)
  );
}
