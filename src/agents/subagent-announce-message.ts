import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import { describeChildrenEndedWithoutResult } from "./subagents/announce/subagent-announce.requester-settle-message.js";
import {
  buildSubagentPrivateCompletionInstruction,
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
} from "./subagents/completion/subagent-completion-instructions.js";
import { SUBAGENT_RESTART_INTERRUPTED_ERROR } from "./subagents/registry/subagent-registry-restart-custody.js";
import type { SubagentRunOutcome } from "./subagents/subagent-run-outcome.types.js";

/** The error upstream's graceful shutdown records (terminateLiveSubagentsForShutdown). */
const GATEWAY_STOPPED_ERROR = "Gateway stopped";

/**
 * A Gateway stop or restart that ended the run is not a task failure: name what ended it, the
 * run, and what was retained, so the requester can choose to re-dispatch or abandon the task.
 */
function describeGatewayInterruption(params: {
  outcome: SubagentRunOutcome;
  childRunId: string;
  noVisibleResult?: boolean;
}): string | undefined {
  const { outcome, childRunId } = params;
  const cause =
    outcome.status !== "error"
      ? undefined
      : outcome.error === GATEWAY_STOPPED_ERROR
        ? `stopped by a graceful Gateway shutdown before run ${childRunId} finished (recorded error: ${GATEWAY_STOPPED_ERROR})`
        : outcome.error === SUBAGENT_RESTART_INTERRUPTED_ERROR
          ? `interrupted: the Gateway restarted before run ${childRunId} ended, and no graceful shutdown reached it`
          : undefined;
  if (!cause) {
    return undefined;
  }
  const retained = params.noVisibleResult
    ? "No result or partial result was retained; any work it saved before then stays in its child session. Inspect it before re-dispatching or abandoning the task."
    : "Its last output before then follows as a partial result.";
  return `${cause}. Not a task failure; the run was not resumed. ${retained}`;
}

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  requesterOrigin: DeliveryContext | undefined;
  completionTarget?: "parent";
  modelRouteChange?: string;
  preserveModelRouteNotice?: boolean;
}): string {
  const modelRouteInstruction = !params.modelRouteChange
    ? ""
    : params.preserveModelRouteNotice
      ? " Preserve any runtime-authored model-route change notice in your update."
      : " Keep runtime-authored model-route change notices internal on this shared surface.";
  if (params.completionTarget === "parent") {
    return buildSubagentPrivateCompletionInstruction(params.requesterOrigin);
  }
  if (params.requesterIsSubagent) {
    return `${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} Convert the reviewed outcome into a concise internal orchestration update for your parent agent in your own words.${modelRouteInstruction} Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed subagent task is ready for parent review. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}${modelRouteInstruction} Otherwise send a truthful user-facing update unless this exact result is already visible to the user in this same turn. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

export function buildSubagentAnnounceMessages(params: {
  requesterIsSubagent: boolean;
  requesterOrigin: DeliveryContext | undefined;
  completionTarget?: "parent";
  childSessionKey: string;
  childSessionId: string;
  childRunId: string;
  taskLabel: string;
  outcome: SubagentRunOutcome;
  /** A killed child produces no further output, so its notice never waits for one. */
  killed?: boolean;
  findings: string;
  noVisibleResult?: boolean;
  statsLine?: string;
  modelRouteChange?: string;
  preserveModelRouteNotice?: boolean;
}): {
  internalEvents: AgentInternalEvent[];
  triggerMessage: string;
} {
  const statusLabel = params.killed
    ? describeChildrenEndedWithoutResult([params.taskLabel])
    : (describeGatewayInterruption(params) ??
      (params.outcome.status === "ok"
        ? "completed; ready for parent review"
        : params.outcome.status === "timeout"
          ? params.outcome.error
            ? `timed out: ${params.outcome.error}`
            : "timed out"
          : params.outcome.status === "error"
            ? `failed: ${params.outcome.error || "unknown error"}`
            : "finished with unknown status"));
  const replyInstruction = buildAnnounceReplyInstruction(params);
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: "subagent",
      announceType: "subagent task",
      childSessionKey: params.childSessionKey,
      childSessionId: params.childSessionId,
      taskLabel: params.taskLabel,
      status: params.outcome.status,
      statusLabel,
      result: params.findings,
      ...(params.noVisibleResult ? { noVisibleResult: true } : {}),
      modelRouteChange: params.modelRouteChange,
      statsLine: params.statsLine,
      replyInstruction,
    },
  ];
  return { internalEvents, triggerMessage: buildAnnounceSteerMessage(internalEvents) };
}
