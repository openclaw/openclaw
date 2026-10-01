import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
} from "../registry/subagent-registry-queries.js";
import { listSubagentRunsForRequester } from "../registry/subagent-registry-read.js";
import { withSubagentRunReadSnapshot } from "../registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { collectSubagentSessionReadKeys } from "../registry/subagent-session-read-scope.js";

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
  const generation = params.settledEntry.generation;
  const rearmGeneration = params.settledEntry.requesterSettleWake?.rearmGeneration;
  const isCurrent = () => {
    const wake = params.settledEntry.requesterSettleWake;
    return (
      !params.signal?.aborted &&
      params.isSourceCurrent() &&
      params.settledEntry.generation === generation &&
      wake !== undefined &&
      wake.rearmGeneration === rearmGeneration &&
      listSubagentRunsForRequester(params.requesterSessionKey, {
        requesterAgentId: params.requesterAgentId,
        requesterStorePath: params.requesterStorePath,
      }).includes(params.settledEntry)
    );
  };
  return async () => {
    if (!isCurrent()) {
      return undefined;
    }
    const result = await withSubagentRunReadSnapshot(
      subagentRuns,
      (snapshot) => {
        if (!isCurrent()) {
          return { runIds: [], sessionKeys: [] };
        }
        const sessionKeys = collectSubagentSessionReadKeys(
          [params.requesterSessionKey],
          snapshot.values(),
        );
        return {
          runIds: [...snapshot.values()]
            .filter((entry) => sessionKeys.has(entry.childSessionKey.trim()))
            .map((entry) => entry.runId),
          sessionKeys: [],
        };
      },
      (_selection, runs) => {
        if (!isCurrent()) {
          return undefined;
        }
        const snapshot = new Map(runs);
        return {
          unsettled: hasDescendantRunAwaitingSettleFromRuns(
            snapshot,
            params.requesterSessionKey,
            params.settledEntry.runId,
            params.requesterAgentId,
            params.requesterStorePath,
            params.settledBefore,
            params.rootRunIds,
          ),
          active: countActiveDescendantRunsFromRuns(
            snapshot,
            params.requesterSessionKey,
            params.requesterAgentId,
            params.requesterStorePath,
            params.rootRunIds,
          ),
        };
      },
      { sessionKeys: [params.requesterSessionKey], descendants: true },
    );
    return isCurrent() ? result : undefined;
  };
}
