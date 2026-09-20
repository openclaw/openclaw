/**
 * Read-only subagent registry accessors.
 *
 * Combines persisted snapshots with in-memory live runs for UI, announce, control, and recovery paths.
 */
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countActiveDescendantRunsFromRuns,
  countPendingDescendantRunsFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  getSubagentRunsSnapshotForSessions,
} from "./subagent-registry-state.js";
import { loadSubagentRunsForChildSessionFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSubagentRunLive } from "./subagent-run-liveness.js";
export { isSubagentRunLive, isSubagentRunQueued } from "./subagent-run-liveness.js";

export type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

/** Builds the session-list index without hydrating full retained registry payloads. */
export function buildSubagentSessionListReadIndex(
  now = Date.now(),
  sessionKeys?: readonly string[],
): SubagentRunReadIndex<SubagentRunReadRecord> {
  const runs = sessionKeys
    ? getSubagentSessionListRunsSnapshotForSessions(subagentRuns, sessionKeys)
    : getSubagentSessionListRunsSnapshotForRead(subagentRuns);
  return buildSubagentRunReadIndexFromRuns({
    runs,
    inMemoryRuns: sessionKeys
      ? [...runs.keys()].flatMap((runId) => {
          const current = subagentRuns.get(runId);
          return current ? [current] : [];
        })
      : subagentRuns.values(),
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

/** Builds an O(1) latest-run lookup from one persisted and in-memory snapshot. */
export function buildLatestSubagentRunReadIndex(): LatestSubagentRunReadIndex {
  return buildLatestSubagentRunReadIndexFromRuns(getSubagentRunsSnapshotForRead(subagentRuns));
}

/** Builds a reusable index from the full readable registry snapshot. */
export function buildSubagentRunReadIndex(now = Date.now()): SubagentRunReadIndex {
  return buildSubagentRunReadIndexFromRuns({
    runs: getSubagentRunsSnapshotForRead(subagentRuns),
    now,
  });
}

/** Lists runs controlled by a session key. */
export function listSubagentRunsForController(
  controllerSessionKey: string,
  controllerAgentId?: string,
): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForController(subagentRuns, controllerSessionKey),
    controllerSessionKey,
    controllerAgentId,
  );
}

/** Counts active descendant runs for a requester/session tree. */
export function countActiveDescendantRuns(
  rootSessionKey: string,
  requesterAgentId?: string,
  requesterStorePath?: string | null,
): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForSessions(subagentRuns, [rootSessionKey]),
    rootSessionKey,
    requesterAgentId,
    requesterStorePath,
  );
}

/** Lists descendant runs under a requester/session tree. */
export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** Counts pending descendant runs below a requester/session tree. */
export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForSessions(subagentRuns, [rootSessionKey]),
    rootSessionKey,
  );
}

/** True when any descendant run still awaits terminal settle (suspended delivery counts as settled). */
export function hasDescendantRunAwaitingSettle(
  rootSessionKey: string,
  excludeRunId?: string,
  requesterAgentId?: string,
  requesterStorePath?: string | null,
  settledBefore?: number,
): boolean {
  return hasDescendantRunAwaitingSettleFromRuns(
    getSubagentRunsSnapshotForSessions(subagentRuns, [rootSessionKey]),
    rootSessionKey,
    excludeRunId,
    requesterAgentId,
    requesterStorePath,
    settledBefore,
  );
}

/** Resolves the requester session and normalized origin for a child subagent session. */
export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey),
    childSessionKey,
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

/** True when post-completion announce should be skipped for a child session. */
export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey),
    childSessionKey,
  );
}

/** True when the process-local registry still owns an active run for the child session. */
export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  // Liveness is mutation ownership, so a persisted snapshot must not outvote the raw live map.
  return isSubagentRunLive(
    getLatestSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey),
  );
}

/** Lists process-local runs requested by one session key. */
export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
    requesterAgentId?: string;
    requesterStorePath?: string | null;
  },
): SubagentRunRecord[] {
  // Request-run lifetime scoping must observe the raw live map, including rows not persisted yet.
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

/** Whether any current or durable generation still owns this logical task, including waits/recovery. */
export function hasSubagentTaskOwner(params: {
  taskRunId: string;
  childSessionKey: string;
  requesterSessionKey: string;
}): boolean {
  const ownsTask = (entry: SubagentRunRecord) =>
    (entry.taskRunId ?? entry.runId) === params.taskRunId &&
    entry.childSessionKey === params.childSessionKey &&
    entry.requesterSessionKey === params.requesterSessionKey;
  for (const entry of getSubagentRunsForChildSession(params.childSessionKey)) {
    if (ownsTask(entry)) {
      return true;
    }
  }
  // Absence permits maintenance to settle stranded tasks. Unlike presentation
  // snapshots, this read must propagate failures rather than treating them as absence.
  return loadSubagentRunsForChildSessionFromSqlite(params.childSessionKey).some(ownsTask);
}

/** Returns the preferred child-session run from its scoped readable snapshot. */
export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, key),
    key,
  );
}

/** Returns the most recently created run for a child session from readable registry state. */
export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsSnapshotForChildSession(subagentRuns, key),
      key,
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
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  // Mutation ownership is process-local; persisted rows can be stale after a replacement.
  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsForChildSession(key),
      key,
      matches,
    ) ?? null
  );
}
