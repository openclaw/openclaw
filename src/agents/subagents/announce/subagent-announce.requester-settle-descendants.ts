import { resolveRecordedRequester } from "../registry/subagent-child-owner-match.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "../registry/subagent-registry-memory.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "../registry/subagent-registry-queries.js";
import {
  getSubagentSessionListRunsSnapshotForSessions,
  prepareSubagentSessionListReadCache,
} from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export function createRequesterDescendantReader(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterStorePath: string | null;
  settledEntry: SubagentRunRecord;
  settledBefore: number;
  rootRunIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  isSourceCurrent: () => boolean;
}) {
  const rearmGeneration = params.settledEntry.requesterSettleWake?.rearmGeneration;
  const isCurrent = () => {
    if (params.signal?.aborted || !params.isSourceCurrent()) {
      return false;
    }
    const current = getCurrentSubagentRunOwner(subagentRuns, params.settledEntry);
    return (
      current?.requesterSettleWake !== undefined &&
      current.requesterSessionKey === params.requesterSessionKey.trim() &&
      (!params.requesterAgentId || resolveRecordedRequester(current) === params.requesterAgentId) &&
      (current.requesterStorePath ?? null) === params.requesterStorePath &&
      current.requesterSettleWake.rearmGeneration === rearmGeneration
    );
  };
  return async () => {
    if (!isCurrent()) {
      return undefined;
    }
    await prepareSubagentSessionListReadCache();
    if (!isCurrent()) {
      return undefined;
    }
    // Settlement needs topology and delivery facts, never retained task/result text.
    const runs = getSubagentSessionListRunsSnapshotForSessions(subagentRuns, [
      params.requesterSessionKey,
    ]);
    for (const runId of runs.keys()) {
      const live = subagentRuns.get(runId);
      if (live) {
        runs.set(runId, live);
      }
    }
    const index = buildScopedSubagentRunReadIndexFromRuns(
      runs,
      params.requesterSessionKey,
      params.requesterAgentId,
      params.requesterStorePath,
      params.rootRunIds,
    );
    const unsettled = index.hasDescendantRunAwaitingSettle(
      params.requesterSessionKey,
      params.settledEntry.runId,
      params.settledBefore,
    );
    const active = index.countActiveDescendantRuns(params.requesterSessionKey);
    // Terminal delivery gets one bounded grace period, derived from durable end
    // times so neither sweeps nor a Gateway restart recharge the wait.
    const deliveryWaitUntil =
      unsettled && active === 0
        ? index
            .listDescendantRunsForRequester(params.requesterSessionKey)
            .reduce(
              (latest, run) => Math.max(latest, run.execution.endedAt ?? 0),
              params.settledEntry.execution.endedAt ?? 0,
            ) +
          5 * 60_000
        : undefined;
    return { unsettled, active, ...(deliveryWaitUntil !== undefined ? { deliveryWaitUntil } : {}) };
  };
}
