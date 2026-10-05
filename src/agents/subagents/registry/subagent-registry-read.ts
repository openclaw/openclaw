import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  countPendingDescendantRunsFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSubagentRunLive } from "./subagent-run-liveness.js";
import { collectSubagentSessionReadKeys } from "./subagent-session-read-scope.js";
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
  preparedRuns?: Map<string, SubagentRunReadRecord>,
): SubagentRunReadIndex<SubagentRunReadRecord> {
  const runs =
    preparedRuns ??
    (sessionKeys
      ? getSubagentSessionListRunsSnapshotForSessions(subagentRuns, sessionKeys)
      : getSubagentSessionListRunsSnapshotForRead(subagentRuns));
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

export function buildLatestSubagentSessionListReadIndex(
  childSessionKeys: readonly string[],
): LatestSubagentRunReadIndex<SubagentRunReadRecord> {
  return buildLatestSubagentRunReadIndexFromRuns(
    getSubagentSessionListRunsSnapshotForChildSessions(childSessionKeys),
  );
}

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

export async function countPendingDescendantRuns(
  rootSessionKey: string,
  assertCurrent: () => void,
): Promise<number> {
  assertCurrent();
  const count = await withSubagentRunReadSnapshot(
    subagentRuns,
    (snapshot) => {
      assertCurrent();
      const sessionKeys = collectSubagentSessionReadKeys([rootSessionKey], snapshot.values());
      return {
        runIds: [...snapshot.values()]
          .filter((entry) => sessionKeys.has(entry.childSessionKey.trim()))
          .map((entry) => entry.runId),
        sessionKeys: [],
      };
    },
    (_selection, runs) => {
      assertCurrent();
      return countPendingDescendantRunsFromRuns(new Map(runs), rootSessionKey);
    },
    { sessionKeys: [rootSessionKey], descendants: true },
  );
  assertCurrent();
  return count;
}

export function resolveRequesterForChildSession(
  childSessionKey: string,
  childAgentId?: string,
): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    childSessionKey,
    childAgentId,
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

export function shouldIgnorePostCompletionAnnounceForSession(
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
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
    getLatestSubagentRunByChildSessionKeyFromRuns(
      subagentRuns,
      childSessionKey,
      undefined,
      childAgentId,
    ),
  );
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: Parameters<typeof listRunsForRequesterFromRuns>[2],
): SubagentRunRecord[] {
  // Request-run lifetime scoping must observe the raw live map, including rows not persisted yet.
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function getSubagentRunByChildSessionKey(
  childSessionKey: string,
  childAgentId?: string,
): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    childSessionKey,
    childAgentId,
  );
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
  childAgentId?: string,
): SubagentRunRecord | null {
  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
      childSessionKey,
      undefined,
      childAgentId,
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
  // Mutation ownership is process-local; persisted rows can be stale after a replacement.
  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      getSubagentRunsForChildSession(key, childAgentId),
      key,
      matches,
      childAgentId,
    ) ?? null
  );
}
