import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { getActiveAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import { mergeAcceptedSessionSpawnsForRun } from "../../accepted-session-spawn.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterAfterSessionSpawns } from "./subagent-registry.js";

/** Account for committed claims; only retired requesters hand their cohort back to settlement. */
export async function reconcileRequesterTurnClaimForRun(params: {
  runId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterRunInstance: OperationalRunInstanceRef;
}): Promise<boolean> {
  const requesterTurnRunId = params.requesterRunInstance.runId;
  const ownedEntries = () =>
    [...getSubagentRunsForRequesterSession(params.requesterSessionKey)].filter(
      (entry) =>
        entry.requesterAgentId === params.requesterAgentId &&
        entry.requesterTurnRunId === requesterTurnRunId &&
        entry.expectsCompletionMessage === true,
    );
  const entries = ownedEntries();
  const acceptedEntry = entries.find((entry) => entry.runId === params.runId);
  if (!acceptedEntry) {
    return false;
  }
  // Acceptance remains a fact when only this tool loses custody after commit.
  mergeAcceptedSessionSpawnsForRun(params.requesterRunInstance, [
    {
      runId: acceptedEntry.taskRunId ?? acceptedEntry.runId,
      childSessionKey: acceptedEntry.childSessionKey,
      expectsCompletionMessage: true,
    },
  ]);
  if (getActiveAgentRunDelegatedAuthority(params.requesterRunInstance)) {
    return true;
  }
  return subagentRuns.runWithCompletionBatchAuthority(entries, async () => {
    const custody = await captureOperatorToolGatewayContinuationContext();
    if (!custody) {
      throw new Error("Committed requester claim has no retained completion custody");
    }
    try {
      const current = ownedEntries();
      if (!current.includes(acceptedEntry)) {
        return false;
      }
      // The transfer owns row retirement; retain source custody independently of those rows.
      return await subagentRuns.runWithCompletionBatchAuthority(current, () =>
        custody.run(() =>
          settleRequesterAfterSessionSpawns({
            ...params,
            requesterTurnRunId,
            requesterYielded: false,
            acceptedSessionSpawns: current.map((entry) => ({
              runId: entry.taskRunId ?? entry.runId,
              childSessionKey: entry.childSessionKey,
              expectsCompletionMessage: true,
            })),
            assertCurrent: custody.assertCurrent,
          }),
        ),
      );
    } finally {
      custody.release();
    }
  });
}
