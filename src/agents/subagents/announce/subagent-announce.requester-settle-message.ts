import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { wrapPromptDataBlock } from "../../sanitize-for-prompt.js";
import {
  buildSubagentPrivateCompletionInstruction,
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
} from "../completion/subagent-completion-instructions.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isSubagentObligationRetired } from "../registry/subagent-requester-settle-identity.js";
import { getSubagentTerminalReplySummary } from "../registry/subagent-run-payload-facts.js";
import {
  buildSubagentRestartRecoveryRoster,
  SUBAGENT_RESTART_RECOVERY_INSTRUCTION,
} from "../subagent-restart-recovery-prompt.js";
import { needsRequesterSettleFindings } from "./subagent-announce.requester-settle-state.js";

const REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS = 1_024;
const ROUTE_NOTICE_TRUNCATION = "\n[model-route changes truncated]";

export function buildRequesterSettleWakeMessage(params: {
  findings?: string;
  requireVisibleReply: boolean;
  parentOnly?: boolean;
  /** A yield handed the conversation back; private results stay input, the final is delivered. */
  yieldedFinalDeliverable?: boolean;
  /** The bounded descendant-delivery wait expired before every result arrived. */
  descendantsUnsettled?: boolean;
  children: readonly SubagentRunRecord[];
  recoveryChildren: readonly SubagentRunRecord[];
  completionChannel?: string;
  requesterOrigin: DeliveryContext | undefined;
  retainedMessage?: string;
  retryMissingResult: boolean;
}): string {
  if (params.retainedMessage !== undefined) {
    return params.retainedMessage;
  }
  const retryInstruction = params.retryMissingResult
    ? "[Subagent Context] The previous continuation ended without the required result. Continue from the current transcript and provide the missing result; do not repeat completed actions."
    : "";
  const child = params.children.length === 1 ? params.children[0] : undefined;
  const pauseNotice =
    child?.pauseReason === "sessions_yield" ? child.requesterSettleWake?.pauseNotice : undefined;
  if (child && pauseNotice) {
    return [
      "[Subagent Context] A child is paused awaiting a continuation; this is not a completion.",
      JSON.stringify({
        state: "paused",
        childSessionKey: child.childSessionKey,
        runId: child.runId,
        label: child.label ?? null,
      }),
      `The child will resume only through sessions_send to ${child.childSessionKey}. Do not wait for its completion without sending the needed continuation.`,
      wrapPromptDataBlock({ label: "Acknowledgment", text: pauseNotice.acknowledgment }),
      ...(retryInstruction ? [retryInstruction] : []),
    ].join("\n");
  }
  const deliveredChildren = params.children.filter((entry) => !needsRequesterSettleFindings(entry));
  // The scheduling row need not be the rerouted child. Keep every current
  // needed child's producer-owned notice, with stable bytes and one batch-wide cap.
  const routeNotices = [
    ...new Set(
      params.children.flatMap((entry) => {
        const reply = getSubagentTerminalReplySummary(entry);
        return needsRequesterSettleFindings(entry) &&
          reply?.disposition === "visible" &&
          reply.modelRouteChange
          ? [reply.modelRouteChange]
          : [];
      }),
    ),
  ]
    .toSorted()
    .join("\n");
  const modelRouteChange =
    routeNotices.length > REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS
      ? `${truncateUtf16Safe(routeNotices, REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS - ROUTE_NOTICE_TRUNCATION.length)}${ROUTE_NOTICE_TRUNCATION}`
      : routeNotices;
  const recoveryRoster = buildSubagentRestartRecoveryRoster(params.recoveryChildren);
  const completionChannel = normalizeMessageChannel(params.completionChannel);
  return [
    params.descendantsUnsettled
      ? "[Subagent Context] Every subagent in this batch has ended, but a descendant result below it was still undelivered when waiting stopped; a child that later receives it may report again in a separate completion."
      : describeSettledBatch(params.children),
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive for it. Other batches may still be running.",
    // Private completion guidance already includes the shared outcome policy.
    ...(params.parentOnly ? [] : [`[Subagent Context] ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`]),
    ...(recoveryRoster
      ? [`[Subagent Context] ${SUBAGENT_RESTART_RECOVERY_INSTRUCTION}`, recoveryRoster]
      : []),
    params.parentOnly
      ? `[Subagent Context] ${buildSubagentPrivateCompletionInstruction(params.requesterOrigin)}`
      : params.yieldedFinalDeliverable
        ? "[Subagent Context] Child results are internal input. Answer the original conversation under its normal reply rules: if replies there must go through the message tool, send your answer with it. Continue any unfinished work, and avoid repeating an update already delivered."
        : params.requireVisibleReply
          ? "[Subagent Context] Child completion delivery is internal; the original user request still requires your visible final answer only after the requested outcome is complete or genuinely blocked."
          : "[Subagent Context] Review the settled results and continue any unfinished work. Avoid repeating a consolidated final answer that was already delivered.",
    ...(modelRouteChange
      ? [
          modelRouteChange,
          !completionChannel || !isDeliverableMessageChannel(completionChannel)
            ? "[Subagent Context] Preserve this runtime-authored model-route change notice in your final answer."
            : "[Subagent Context] Keep this runtime-authored model-route change notice internal on this shared surface.",
        ]
      : []),
    "",
    ...(deliveredChildren.length
      ? [
          `Already delivered child results (not repeated): ${deliveredChildren
            .map((entry) => entry.runId)
            .toSorted()
            .join(", ")}.`,
        ]
      : []),
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
    ...(retryInstruction ? [retryInstruction] : []),
  ].join("\n");
}

/** The one wording for children that were stopped, killed, or deleted before finishing. */
export function describeChildrenEndedWithoutResult(labels: readonly string[]): string {
  return `ended without a result: ${labels.length} stopped, killed, or deleted before finishing (${labels.join("; ")})`;
}

// A cohort whose every member was stopped, killed, or deleted resolves with no result to review.
function describeSettledBatch(children: readonly SubagentRunRecord[]): string {
  if (children.length === 0 || !children.every(isSubagentObligationRetired)) {
    return "[Subagent Context] Every subagent in this batch has now settled, including its descendants.";
  }
  const labels = children.map(
    (child) => child.label?.trim() || child.taskName?.trim() || child.task.trim() || child.runId,
  );
  return `[Subagent Context] Every child in this batch ${describeChildrenEndedWithoutResult(labels)}.`;
}
