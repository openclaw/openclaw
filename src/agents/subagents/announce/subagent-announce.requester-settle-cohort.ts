import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isRequesterCompletionCohortCurrent } from "../registry/subagent-requester-settle-identity.js";
import {
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";

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
