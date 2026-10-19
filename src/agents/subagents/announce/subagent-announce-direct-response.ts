/** Interprets direct announcement responses and the existing text-fallback receipt. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  getAutomaticDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleAgentPayload } from "../../embedded-agent-runner/message-visibility.js";
import type { ReplyExpectation } from "../../reply-completion.js";
import {
  buildRequesterCompletionDeliveryResult,
  hasMessagingToolDeliveryToSource,
  isGatewayAgentRunPending,
  resolvePrivateCompletionDeliveryResult,
} from "./subagent-announce-completion-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";

type DirectAnnounceResponseContext = {
  params: {
    sourceTool?: string;
    expectsCompletionMessage: boolean;
    requesterIsSubagent: boolean;
  };
  parentOnly: boolean;
  requesterSessionBound: boolean;
  replyExpectation: ReplyExpectation | undefined;
  deliveryTarget: Parameters<typeof hasMessagingToolDeliveryToSource>[1];
  shouldDeliverAgentFinal: boolean;
  requiresMessageToolDelivery: boolean;
  isSubagentCompletion: boolean;
  hasSuccessfulTrustedSubagentNoOutputCompletion: boolean;
  hasRequiredSubagentNoOutputCompletion: boolean;
  subagentDirectMessageCompletionRequiresMessageTool: boolean;
  effectiveDirectOrigin: DeliveryContext | undefined;
  requesterSessionOrigin: DeliveryContext | undefined;
  textCompletionDirectDeliveryKind: "completed_result" | "failed_notice";
  tryTextCompletionDirectDelivery: (
    kind: "completed_result" | "failed_notice",
    agentResult?: { payloads?: unknown },
  ) => Promise<SubagentAnnounceDeliveryResult | undefined>;
};

function missingVisibleReplyResult(completedSuccessfully: boolean): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
    error: "completion agent did not produce a visible reply",
    ...(completedSuccessfully ? { disposition: "retryable" as const } : {}),
  };
}

/** Reuses prepared facts; only the existing text-delivery owner may perform a send. */
export function createDirectAnnounceResponseClassifier(context: DirectAnnounceResponseContext) {
  const {
    params,
    parentOnly,
    requesterSessionBound,
    replyExpectation,
    deliveryTarget,
    shouldDeliverAgentFinal,
    requiresMessageToolDelivery,
    isSubagentCompletion,
    hasSuccessfulTrustedSubagentNoOutputCompletion,
    hasRequiredSubagentNoOutputCompletion,
    subagentDirectMessageCompletionRequiresMessageTool,
    effectiveDirectOrigin,
    requesterSessionOrigin,
    textCompletionDirectDeliveryKind,
    tryTextCompletionDirectDelivery,
  } = context;
  return (
    directAnnounceResponse: unknown,
  ): SubagentAnnounceDeliveryResult | Promise<SubagentAnnounceDeliveryResult> => {
    if (isGatewayAgentRunPending(directAnnounceResponse)) {
      return parentOnly || params.sourceTool === "subagent_settle"
        ? {
            delivered: false,
            path: "direct",
            reason: "requester_turn_pending",
            disposition: "session_queued",
          }
        : { delivered: true, path: "direct" };
    }

    const directAnnounceResult = getGatewayAgentResult(directAnnounceResponse);
    const directAnnounceRecord = asOptionalRecord(directAnnounceResponse);
    if (parentOnly) {
      return resolvePrivateCompletionDeliveryResult(
        directAnnounceRecord,
        params.requesterIsSubagent ? undefined : effectiveDirectOrigin,
      );
    }
    const hasFinalMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
        requireFinalReply: true,
      }),
    );
    const hasMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
    );
    const terminalReply = normalizeAgentRunTerminalReplySnapshot(
      directAnnounceResult?.meta?.terminalReply,
    );
    const hasIntentionalSilentCompletionReply = terminalReply?.disposition === "silent";
    const hasVisibleNonSilentGatewayPayload = Boolean(
      directAnnounceResult &&
      !hasIntentionalSilentCompletionReply &&
      hasVisibleAgentPayload(directAnnounceResult, {
        includeErrorPayloads: false,
        includeReasoningPayloads: false,
        requireTerminalContent: true,
      }),
    );
    // Only a completed external turn may satisfy its reply obligation with silence.
    const requesterCompletedSuccessfully =
      directAnnounceRecord?.status === "ok" &&
      !directAnnounceResult?.meta?.error &&
      !directAnnounceResult?.meta?.aborted;
    const acceptsIntentionalSilentCompletion =
      replyExpectation !== "result-required" &&
      requesterCompletedSuccessfully &&
      hasIntentionalSilentCompletionReply &&
      directAnnounceResult?.meta?.yielded !== true &&
      directAnnounceResult?.meta?.continuationPending !== true;
    const requiresSettleReply =
      params.sourceTool === "subagent_settle" && !acceptsIntentionalSilentCompletion;
    const requiresAutomaticFinalReceipt =
      shouldDeliverAgentFinal && (params.expectsCompletionMessage || requiresSettleReply);
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
      (automaticEvidence.mayHaveSent ||
        automaticEvidence.suppressionReason !== "no_visible_payload")
    ) {
      if (
        automaticEvidence.suppressionReason === "message_tool_only" &&
        !automaticEvidence.mayHaveSent &&
        (!requesterCompletedSuccessfully ||
          directAnnounceResult?.meta?.yielded === true ||
          directAnnounceResult?.meta?.continuationPending === true)
      ) {
        return missingVisibleReplyResult(requesterCompletedSuccessfully);
      }
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
      requesterCompletedSuccessfully &&
      directAnnounceResult?.meta?.yielded === true &&
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
    const hasCompletionSideEffect = Boolean(
      directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
    );
    const hasVisibleRequiredCompletionReply =
      hasMessagingToolDelivery ||
      (!requiresMessageToolDelivery && hasVisibleNonSilentGatewayPayload);
    const finishClassification = ():
      | SubagentAnnounceDeliveryResult
      | Promise<SubagentAnnounceDeliveryResult> => {
      if (
        hasSuccessfulTrustedSubagentNoOutputCompletion &&
        !hasVisibleRequiredCompletionReply &&
        hasCompletionSideEffect
      ) {
        return {
          ...missingVisibleReplyResult(requesterCompletedSuccessfully),
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
          return missingVisibleReplyResult(requesterCompletedSuccessfully);
        }
        const missingDelivery: SubagentAnnounceDeliveryResult = {
          delivered: false,
          path: "direct",
          reason: "message_tool_delivery_missing",
          error: "completion agent did not use the message tool for message-tool-only delivery",
          // The requester execution finished; another agent turn can repeat its
          // effects. Retain the completion for explicit recovery instead.
          disposition: "permanent_failure",
        };
        return subagentDirectMessageCompletionRequiresMessageTool &&
          (!hasIntentionalSilentCompletionReply ||
            textCompletionDirectDeliveryKind === "failed_notice")
          ? tryTextCompletionDirectDelivery(
              textCompletionDirectDeliveryKind,
              directAnnounceResult ?? undefined,
            ).then((textDelivery) => textDelivery ?? missingDelivery)
          : missingDelivery;
      }
      const hasRequesterVisibleFinalDelivery =
        hasFinalMessagingToolDelivery || (shouldDeliverAgentFinal && automaticFinalDelivered);
      const hasVisibleCompletionReply =
        hasRequesterVisibleFinalDelivery ||
        (!shouldDeliverAgentFinal && hasMessagingToolDelivery) ||
        // Nested requesters and internal sessions observe the final in their transcript.
        // Unresolved external origins still require delivery evidence.
        (!requiresMessageToolDelivery &&
          hasVisibleNonSilentGatewayPayload &&
          (!requesterSessionBound || requesterCompletedSuccessfully) &&
          directAnnounceResult?.deliveryStatus?.status !== "suppressed" &&
          (params.requesterIsSubagent ||
            [effectiveDirectOrigin, requesterSessionOrigin].every((origin) =>
              origin?.channel
                ? normalizeMessageChannel(origin.channel) === INTERNAL_MESSAGE_CHANNEL
                : !origin?.to,
            )));
      if (
        !hasVisibleCompletionReply &&
        !acceptsIntentionalSilentCompletion &&
        (replyExpectation === "result-required" ||
          requiresSettleReply ||
          (params.expectsCompletionMessage &&
            (shouldDeliverAgentFinal ||
              (!requiresMessageToolDelivery && !hasCompletionSideEffect))))
      ) {
        return missingVisibleReplyResult(requesterCompletedSuccessfully);
      }
      const requesterVisibleFinalCommitted =
        !params.requesterIsSubagent &&
        (hasRequesterVisibleFinalDelivery ||
          (!params.expectsCompletionMessage &&
            directAnnounceRecord?.status === "ok" &&
            hasVisibleNonSilentGatewayPayload &&
            hasVisibleCompletionReply));
      return buildRequesterCompletionDeliveryResult(
        requesterVisibleFinalCommitted,
        directAnnounceResult?.meta?.finalAssistantVisibleText,
      );
    };

    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleNonSilentGatewayPayload &&
      (!hasIntentionalSilentCompletionReply ||
        textCompletionDirectDeliveryKind === "failed_notice") &&
      !hasMessagingToolDelivery
    ) {
      return tryTextCompletionDirectDelivery(
        textCompletionDirectDeliveryKind,
        directAnnounceResult ?? undefined,
      ).then<SubagentAnnounceDeliveryResult>((textDelivery) => {
        if (textDelivery) {
          return textDelivery;
        }
        if (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect) {
          return missingVisibleReplyResult(requesterCompletedSuccessfully);
        }
        return finishClassification();
      });
    }
    return finishClassification();
  };
}
