import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

export async function restoreSubagentRunMetadata(
  runs: Map<string, SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
) {
  const cfg = getRuntimeConfig();
  const plan = (rows: ReadonlyMap<string, SubagentRunRecord>) => {
    const postimages = new Map<string, SubagentRunRecord>();
    for (const [runId, entry] of rows) {
      const authority = resolveSubagentChildAuthority(entry);
      if (authority.status === "mismatch") {
        continue;
      }
      const draft = copySubagentRunRuntimeOwner(entry, { ...entry });
      const requesterAgentId = resolveSubagentRequesterAgentId(cfg, draft);
      const ownerChanged =
        authority.status === "verified" &&
        !draft.requesterAgentId &&
        requesterAgentId !== undefined;
      if (ownerChanged) {
        draft.requesterAgentId = requesterAgentId;
      }
      const interruptedShutdown =
        draft.expectsCompletionMessage === true &&
        draft.delivery?.status === "pending" &&
        draft.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        draft.execution.outcome?.status === "error" &&
        draft.execution.outcome.error === "Gateway stopped" &&
        draft.killReconciliation?.suppressTaskDelivery === true &&
        draft.killReconciliation.taskCancellationAccepted !== true;
      if (interruptedShutdown) {
        // Older shutdowns recorded interruption as a quiet kill. Restore the owed outcome;
        // requester recovery still admits delivery under its current authority.
        draft.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        draft.killReconciliation = undefined;
        draft.suppressAnnounceReason = undefined;
        draft.suppressCompletionDelivery = undefined;
        draft.cleanupHandled = false;
        draft.cleanupCompletedAt = undefined;
        draft.completion = {
          ...draft.completion,
          required: true,
          resultText: draft.completion?.resultText ?? null,
          capturedAt: draft.completion?.capturedAt ?? draft.execution.endedAt,
        };
      }
      const unfinishedCollector =
        draft.collect && draft.execution.status === "terminal" && !draft.collectorCompletion;
      if (unfinishedCollector) {
        // Shutdown can retire execution before its collector result publishes.
        draft.completion = draft.completion ? { ...draft.completion } : undefined;
        updateSwarmCollectorCompletion(draft, cfg, { entry: undefined });
      }
      if (
        interruptedShutdown ||
        unfinishedCollector ||
        updateSubagentArchiveAtMs(draft, cfg) ||
        ownerChanged
      ) {
        postimages.set(runId, draft);
      }
    }
    return { value: undefined, postimages };
  };
  // Retained rows keep text in SQLite; only changed metadata needs a full write payload.
  const runIds = [...plan(runs).postimages.keys()];
  if (runIds.length > 0) {
    await mutateSubagentRuns(runIds, plan, { runs, context, assertCurrent });
  }
}
