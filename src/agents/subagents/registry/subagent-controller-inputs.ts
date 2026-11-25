import {
  abortSessionControllerInput,
  sessionControllerMailboxes,
} from "../../../sessions/session-controller.mailbox.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

/** The stable reservation ID of a run's individual completion input. */
export const subagentCompletionSourceId = (entry: SubagentRunRecord) =>
  `subagent-completion:${entry.runId}:${entry.generation ?? 0}`;

/** Exact membership is required: sibling IDs and earlier yield generations are distinct inputs. */
function* subagentControllerInputs(entry: SubagentRunRecord) {
  const completionId = subagentCompletionSourceId(entry);
  const wake = entry.requesterSettleWake;
  const pause = entry.pauseReason === "sessions_yield" && Boolean(wake?.pauseNotice);
  const batchRunIds = (pause ? [entry.runId] : wake?.batchRunIds)?.filter((runId) => {
    const member = runId === entry.runId ? entry : subagentRuns.get(runId);
    return (
      member?.requesterSessionKey === entry.requesterSessionKey &&
      member.requesterAgentId === entry.requesterAgentId &&
      member.requesterStorePath === entry.requesterStorePath &&
      member.requesterSettleWake !== undefined &&
      member.requesterSettleWake.rearmGeneration === wake?.rearmGeneration
    );
  });
  const belongsToBatch = batchRunIds?.includes(entry.runId) === true;
  for (const mailbox of sessionControllerMailboxes()) {
    const target = mailbox.owner.target;
    if (
      !target ||
      !matchesSubagentChildSessionOwner(
        { childSessionKey: entry.requesterSessionKey, childAgentId: entry.requesterAgentId },
        mailbox.key,
        target.agentId,
      )
    ) {
      continue;
    }
    const batchIds = belongsToBatch
      ? [entry.requesterAgentId, target.agentId].map(
          (requesterAgentId) =>
            buildRequesterSettleWakeIdentity({
              requesterSessionKey: entry.requesterSessionKey,
              requesterAgentId,
              batchRunIds: batchRunIds!,
              rearmGeneration: wake?.rearmGeneration,
              pause,
            }).batchKey,
        )
      : [];
    for (const input of mailbox.entries.slice()) {
      const sourceTarget = input.target ?? target;
      if (
        (!entry.requesterStorePath ||
          (sourceTarget.physicalStorePath ?? sourceTarget.storeScope) ===
            entry.requesterStorePath) &&
        input.phase !== "consumed" &&
        (input.sourceTurnId === completionId ||
          (input.sourceTurnId !== undefined && batchIds.includes(input.sourceTurnId)))
      ) {
        yield input;
      }
    }
  }
}

export const hasSubagentControllerInput = (entry: SubagentRunRecord): boolean =>
  !subagentControllerInputs(entry).next().done;

/** Claimed turns revalidate at execution; retire only this obligation's unclaimed inputs. */
export function retireSubagentControllerInputs(entry: SubagentRunRecord): void {
  captureSubagentControllerInputRetirement(entry)();
}

/** Capture before settlement removes the frozen membership used to identify its reservations. */
export function captureSubagentControllerInputRetirement(entry: SubagentRunRecord): () => void {
  const inputs = [...subagentControllerInputs(entry)];
  return () => {
    for (const input of inputs) {
      if (!input.claim) {
        abortSessionControllerInput(input, new Error("Subagent obligation retired"));
      }
    }
  };
}

/** A terminal individual delivery releases its reservation, not the requester's owed cohort. */
export function retireSubagentCompletionControllerInput(entry: SubagentRunRecord): void {
  const completionId = subagentCompletionSourceId(entry);
  for (const input of subagentControllerInputs(entry)) {
    if (input.sourceTurnId === completionId && !input.claim) {
      abortSessionControllerInput(input, new Error("Subagent completion delivery settled"));
    }
  }
}
