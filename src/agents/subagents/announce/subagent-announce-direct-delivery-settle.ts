/**
 * Settle a completed public direct-announce agent response into a delivery result.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import {
  getAgentCommandDeliveryFailure,
  getAutomaticDeliveryEvidence,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
} from "../../embedded-agent-runner/message-visibility.js";
import { hasMessagingToolDeliveryToSource } from "./subagent-announce-completion-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";

const REQUESTER_FINAL_VISIBLE_TEXT_MAX_CHARS = 12_000;

export type DirectAnnounceTextCompletionKind = "completed_result" | "failed_notice";

export type DirectAnnounceDeliveryTarget = {
  deliver: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export async function settlePublicDirectAnnounceDelivery(params: {
  directAnnounceResponse: unknown;
  deliveryTarget: DirectAnnounceDeliveryTarget;
  shouldDeliverAgentFinal: boolean;
  expectsCompletionMessage: boolean;
  requireVisibleReply?: boolean;
  requiresMessageToolDelivery: boolean;
  isSubagentCompletion: boolean;
  subagentDirectMessageCompletionRequiresMessageTool: boolean;
  textCompletionDirectDeliveryKind: DirectAnnounceTextCompletionKind;
  hasSuccessfulTrustedSubagentNoOutputCompletion: boolean;
  hasRequiredSubagentNoOutputCompletion: boolean;
  requesterIsSubagent: boolean;
  effectiveDirectOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  tryTextCompletionDirectDelivery: (
    contentKind?: DirectAnnounceTextCompletionKind,
  ) => Promise<SubagentAnnounceDeliveryResult | undefined>;
}): Promise<SubagentAnnounceDeliveryResult> {
  const directAnnounceResult = getGatewayAgentResult(params.directAnnounceResponse);
  const directAnnounceRecord = asOptionalRecord(params.directAnnounceResponse);
  const {
    deliveryTarget,
    shouldDeliverAgentFinal,
    requiresMessageToolDelivery,
    isSubagentCompletion,
    subagentDirectMessageCompletionRequiresMessageTool,
    textCompletionDirectDeliveryKind,
    hasSuccessfulTrustedSubagentNoOutputCompletion,
    hasRequiredSubagentNoOutputCompletion,
    requesterIsSubagent,
    effectiveDirectOrigin,
    requesterSessionOrigin,
    tryTextCompletionDirectDelivery,
  } = params;

  const hasFinalMessagingToolDelivery = Boolean(
    directAnnounceResult &&
    hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
      requireFinalReply: true,
    }),
  );
  const hasMessagingToolDelivery = Boolean(
    directAnnounceResult && hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
  );
  const requiresAutomaticFinalReceipt =
    shouldDeliverAgentFinal && (params.expectsCompletionMessage || params.requireVisibleReply);
  const automaticEvidence = getAutomaticDeliveryEvidence(directAnnounceResult ?? {});
  const directDeliveryFailure =
    (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
      ? getAgentCommandDeliveryFailure(directAnnounceResult)
      : undefined;
  // Automatic-delivery diagnostics and a committed source message are independent facts.
  // Once the message tool delivered the owed final, the task must settle as delivered.
  if (
    directDeliveryFailure &&
    !(requiresAutomaticFinalReceipt ? hasFinalMessagingToolDelivery : hasMessagingToolDelivery)
  ) {
    return {
      delivered: false,
      path: "direct",
      error: directDeliveryFailure,
      ...(automaticEvidence.mayHaveSent ? { disposition: "ambiguous" as const } : {}),
    };
  }
  const hasVisibleNonSilentGatewayPayload = Boolean(
    directAnnounceResult &&
    hasVisibleAgentPayload(directAnnounceResult, {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
      requireTerminalContent: true,
      includeSilentReplyPayloads: false,
    }),
  );
  const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(
    directAnnounceResult?.deliveryStatus,
  );
  const automaticFinalDelivered =
    terminalDelivery?.status === "sent" && terminalDelivery.resultCount > 0;
  if (
    requiresAutomaticFinalReceipt &&
    !hasFinalMessagingToolDelivery &&
    terminalDelivery?.status === "suppressed" &&
    // Only genuinely empty output can fall back; another payload may have
    // been sent or intentionally cancelled by policy.
    (automaticEvidence.mayHaveSent || automaticEvidence.suppressionReason !== "no_visible_payload")
  ) {
    return {
      delivered: false,
      path: "direct",
      reason: automaticEvidence.mayHaveSent ? undefined : "delivery_suppressed",
      error: automaticEvidence.mayHaveSent
        ? "automatic completion delivery could not be confirmed"
        : (automaticEvidence.suppressionReason ?? "automatic completion delivery suppressed"),
      disposition: automaticEvidence.mayHaveSent ? "ambiguous" : "intentional_non_delivery",
      terminal: automaticEvidence.mayHaveSent ? undefined : true,
    };
  }
  if (
    directAnnounceRecord?.status === "ok" &&
    directAnnounceResult?.meta?.yielded === true &&
    !directAnnounceResult.meta.error &&
    !directAnnounceResult.meta.aborted &&
    !automaticFinalDelivered
  ) {
    if (
      directAnnounceResult.requesterContinuationSettled === true &&
      !hasFinalMessagingToolDelivery &&
      !hasVisibleNonSilentGatewayPayload
    ) {
      // Core owns the next wave or observed it complete. Real final evidence
      // still follows its normal path below.
      return { delivered: true, path: "direct" };
    }
    if (
      isSubagentCompletion &&
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasMessagingToolDelivery
    ) {
      // A yielded requester still owns pending work, not a tool-running fallback.
      return {
        delivered: false,
        path: "direct",
        reason: "completion_handoff_pending",
        disposition: "session_queued",
      };
    }
  }
  const hasIntentionalSilentCompletionReply = Boolean(
    directAnnounceResult && hasIntentionalSilentAgentPayload(directAnnounceResult),
  );
  const hasCompletionSideEffect = Boolean(
    directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
  );
  const hasVisibleRequiredCompletionReply =
    hasMessagingToolDelivery || (!requiresMessageToolDelivery && hasVisibleNonSilentGatewayPayload);
  if (
    params.expectsCompletionMessage &&
    shouldDeliverAgentFinal &&
    isSubagentCompletion &&
    !hasVisibleNonSilentGatewayPayload &&
    !hasMessagingToolDelivery
  ) {
    const textDelivery = await tryTextCompletionDirectDelivery(textCompletionDirectDeliveryKind);
    if (textDelivery) {
      return textDelivery;
    }
    if (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }
  }
  if (
    hasSuccessfulTrustedSubagentNoOutputCompletion &&
    !hasVisibleRequiredCompletionReply &&
    hasCompletionSideEffect
  ) {
    return {
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
      error: "completion agent did not produce a visible reply",
      disposition: "permanent_failure",
    };
  }
  if (
    params.expectsCompletionMessage &&
    requiresMessageToolDelivery &&
    !hasMessagingToolDelivery &&
    (!hasIntentionalSilentCompletionReply ||
      subagentDirectMessageCompletionRequiresMessageTool ||
      hasRequiredSubagentNoOutputCompletion)
  ) {
    if (hasSuccessfulTrustedSubagentNoOutputCompletion) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }
    if (subagentDirectMessageCompletionRequiresMessageTool) {
      const textDelivery = await tryTextCompletionDirectDelivery(textCompletionDirectDeliveryKind);
      if (textDelivery) {
        return textDelivery;
      }
    }
    return {
      delivered: false,
      path: "direct",
      reason: "message_tool_delivery_missing",
      error: "completion agent did not use the message tool for message-tool-only delivery",
      // The requester execution finished; another agent turn can repeat its
      // effects. Retain the completion for explicit recovery instead.
      disposition: "permanent_failure",
    };
  }
  const hasRequesterVisibleFinalDelivery =
    hasFinalMessagingToolDelivery || (shouldDeliverAgentFinal && automaticFinalDelivered);
  const hasVisibleCompletionReply =
    hasRequesterVisibleFinalDelivery ||
    (!shouldDeliverAgentFinal && !params.requireVisibleReply && hasMessagingToolDelivery) ||
    // Nested requesters and internal sessions observe the final in their transcript.
    // Unresolved external origins still require delivery evidence.
    (!requiresMessageToolDelivery &&
      hasVisibleNonSilentGatewayPayload &&
      directAnnounceResult?.deliveryStatus?.status !== "suppressed" &&
      (requesterIsSubagent ||
        [effectiveDirectOrigin, requesterSessionOrigin].every((origin) =>
          origin?.channel
            ? normalizeMessageChannel(origin.channel) === INTERNAL_MESSAGE_CHANNEL
            : !origin?.to,
        )));
  const acceptsIntentionalSilentCompletion =
    hasIntentionalSilentCompletionReply && !isSubagentCompletion;
  if (
    !hasVisibleCompletionReply &&
    (params.requireVisibleReply ||
      (params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal ||
          (!requiresMessageToolDelivery &&
            !hasCompletionSideEffect &&
            !acceptsIntentionalSilentCompletion))))
  ) {
    return {
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
      error: "completion agent did not produce a visible reply",
    };
  }
  const requesterVisibleFinalCommitted =
    !requesterIsSubagent &&
    (hasRequesterVisibleFinalDelivery ||
      (!params.expectsCompletionMessage &&
        directAnnounceRecord?.status === "ok" &&
        hasVisibleNonSilentGatewayPayload &&
        hasVisibleCompletionReply));
  const finalAssistantVisibleText =
    requesterVisibleFinalCommitted &&
    typeof directAnnounceResult?.meta?.finalAssistantVisibleText === "string"
      ? truncateUtf16Safe(
          directAnnounceResult.meta.finalAssistantVisibleText.trim(),
          REQUESTER_FINAL_VISIBLE_TEXT_MAX_CHARS,
        )
      : "";

  return {
    delivered: true,
    path: "direct",
    // Synthetic wakes can commit their final to the requester transcript.
    // A canceled partial payload or accepted handoff is not that receipt.
    ...(requesterVisibleFinalCommitted ? { requesterVisibleFinalDelivered: true } : {}),
    ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
  };
}
