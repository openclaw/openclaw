import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { getActiveAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  retireAcceptedSessionSpawnCompletionForRun,
} from "../../accepted-session-spawn.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { resumeSubagentRun, settleRequesterAfterSessionSpawns } from "./subagent-registry.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

/** An inline terminal result consumes the same durable obligation as a late completion. */
export async function acknowledgeSubagentResultForRequesterTurn(params: {
  runId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
  requesterTurnRunId: string;
}): Promise<void> {
  const assertCurrent = captureGatewayToolCallerAssertion();
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const accepted = await mutateSubagentRuns(
    [params.runId],
    (rows) => {
      const entry = rows.get(params.runId);
      if (
        !entry ||
        entry.requesterSessionKey !== params.requesterSessionKey ||
        entry.requesterAgentId !== params.requesterAgentId ||
        entry.requesterTurnRunId !== params.requesterTurnRunId ||
        entry.requesterTurnYielded ||
        entry.killIntent ||
        entry.killReconciliation
      ) {
        throw new Error("Inline child result no longer belongs to its requester turn.");
      }
      const next = {
        ...entry,
        expectsCompletionMessage: false,
        completion: { ...entry.completion, required: false },
        delivery: { status: "delivered" as const, announcedAt: Date.now() },
      };
      return {
        value: {
          receipt: {
            runId: entry.taskRunId ?? entry.runId,
            childSessionKey: entry.childSessionKey,
          },
          ended: hasSubagentRunEnded(entry),
        },
        postimages: new Map([[entry.runId, next]]),
      };
    },
    { runs: subagentRuns, assertCurrent },
  );
  if (instance) {
    retireAcceptedSessionSpawnCompletionForRun(instance, accepted.receipt);
  }
  // A run that ended under the live inline claim deferred its cleanup to this owner;
  // later endings reach cleanup through their own lifecycle once the claim is released.
  if (accepted.ended) {
    resumeSubagentRun(params.runId);
  }
}

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
