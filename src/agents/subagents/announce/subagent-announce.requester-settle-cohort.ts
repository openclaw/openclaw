import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isRequesterCompletionCohortCurrent } from "../registry/subagent-requester-settle-identity.js";
import {
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";

/**
 * Current members of a frozen wave. Retired rows no longer own its completion, and a
 * member whose consumed pause notice detached it into its own wave leaves this one.
 */
export function selectFrozenWave(
  settled: SubagentRunRecord,
  rows: readonly SubagentRunRecord[],
): { members: SubagentRunRecord[]; waveRunIds: string[] } {
  const runsById = new Map(rows.map((entry) => [entry.runId, entry]));
  const generation = settled.requesterSettleWake?.rearmGeneration;
  const members: SubagentRunRecord[] = [];
  const waveRunIds: string[] = [];
  for (const runId of settled.requesterSettleWake?.batchRunIds ?? []) {
    const entry = runsById.get(runId);
    const wake = entry?.requesterSettleWake;
    const sameGeneration = wake && wake.rearmGeneration === generation;
    if (sameGeneration && wake.batchRunIds?.includes(settled.runId) === false) {
      continue;
    }
    waveRunIds.push(runId);
    if (entry && sameGeneration) {
      members.push(entry);
    }
  }
  return { members, waveRunIds };
}

export function selectCurrentRequesterCompletionRows(params: {
  rows: SubagentRunRecord[];
  requesterSessionKey: string;
  requesterAgentId?: string;
  frozenBatch: boolean;
  latestForSession: Parameters<typeof isRequesterCompletionCohortCurrent>[1];
}): SubagentRunRecord[] {
  if (params.frozenBatch) {
    return params.rows.filter((entry) =>
      isRequesterCompletionCohortCurrent(entry, params.latestForSession),
    );
  }
  return dedupeLatestChildCompletionRows(
    filterCurrentDirectChildCompletionRows(params.rows, {
      requesterSessionKey: params.requesterSessionKey,
      requesterAgentId: params.requesterAgentId,
      getLatestSubagentRunByChildSessionKey: (childSessionKey, childAgentId) =>
        params.latestForSession(childSessionKey, undefined, childAgentId),
    }),
  );
}
