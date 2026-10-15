import { resolveRecordedRequester } from "../registry/subagent-child-owner-match.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "../registry/subagent-registry-memory.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "../registry/subagent-registry-queries.js";
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
        const index = buildScopedSubagentRunReadIndexFromRuns(
          new Map(runs),
          params.requesterSessionKey,
          params.requesterAgentId,
          params.requesterStorePath,
          params.rootRunIds,
        );
        return {
          unsettled: index.hasDescendantRunAwaitingSettle(
            params.requesterSessionKey,
            params.settledEntry.runId,
            params.settledBefore,
          ),
          active: index.countActiveDescendantRuns(params.requesterSessionKey),
        };
      },
      { sessionKeys: [params.requesterSessionKey], descendants: true },
    );
    return isCurrent() ? result : undefined;
  };
}
