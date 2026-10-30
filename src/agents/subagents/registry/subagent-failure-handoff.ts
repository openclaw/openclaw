import type { UserTurnTranscriptAdmissionReceipt } from "../../../sessions/user-turn-transcript.types.js";
import { isSameOpenClawAgentDatabasePath } from "../../../state/openclaw-agent-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { isFailedTerminalSubagentRun } from "../subagent-failure.js";
import { ensureDeliveryState } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSubagentObligationRetired } from "./subagent-requester-settle-identity.js";
import { copySubagentRunRuntimeOwner, isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** The input/collector owner calls only after its durable commit notification. */
export async function recordSubagentFailureHandoff(params: {
  entries: readonly SubagentRunRecord[];
  requester: Pick<UserTurnTranscriptAdmissionReceipt, "sessionKey" | "sessionId" | "storePath">;
  collector?: { lifecycleRevision?: string; ownsRun: (entry: SubagentRunRecord) => boolean };
  assertCurrent: () => void;
  context?: OpenClawStateWorkerContext;
}) {
  const selected = params.entries.filter(isFailedTerminalSubagentRun);
  if (!selected.length) {
    return;
  }
  const assertCurrent = () => {
    params.assertCurrent();
    for (const observed of selected) {
      const current = subagentRuns.get(observed.runId);
      if (
        current &&
        (!isSameSubagentRunOwner(current, observed) || isSubagentObligationRetired(current))
      ) {
        throw new SubagentRegistryMutationRejectedError("Failure handoff source changed");
      }
    }
  };
  await mutateSubagentRuns(
    selected.map((entry) => entry.runId),
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const observed of selected) {
        const current = rows.get(observed.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, observed) ||
          !isFailedTerminalSubagentRun(current) ||
          isSubagentObligationRetired(current) ||
          (params.collector
            ? !current.collect || !params.collector.ownsRun(current)
            : current.requesterSessionKey !== params.requester.sessionKey ||
              current.completionRequesterSessionId !== params.requester.sessionId ||
              !current.requesterStorePath ||
              !isSameOpenClawAgentDatabasePath(
                current.requesterStorePath,
                params.requester.storePath,
              ))
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Failure handoff requester or source changed",
          );
        }
        const handoff = {
          requesterSessionKey: params.requester.sessionKey,
          requesterSessionId: params.requester.sessionId,
          requesterLifecycleRevision: params.collector
            ? params.collector.lifecycleRevision
            : current.completionRequesterLifecycleRevision,
          requesterStorePath: params.requester.storePath,
        };
        const previous = current.delivery?.failureHandoff;
        if (
          previous &&
          previous.requesterSessionKey === handoff.requesterSessionKey &&
          previous.requesterSessionId === handoff.requesterSessionId &&
          previous.requesterLifecycleRevision === handoff.requesterLifecycleRevision &&
          previous.requesterStorePath === handoff.requesterStorePath
        ) {
          continue;
        }
        const draft = copySubagentRunRuntimeOwner(current, structuredClone(current));
        ensureDeliveryState(draft).failureHandoff = handoff;
        postimages.set(draft.runId, draft);
      }
      return { value: undefined, postimages };
    },
    {
      assertCurrent,
      context: params.context,
      preparedRows: () => new Map(selected.map((entry) => [entry.runId, entry])),
    },
  );
}
