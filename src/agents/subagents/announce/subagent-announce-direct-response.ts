/** Interprets direct announcement responses and the existing text-fallback receipt. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  getAutomaticDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
} from "../../embedded-agent-runner/message-visibility.js";
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
    requireVisibleReply?: boolean;
    requesterIsSubagent: boolean;
  };
  parentOnly: boolean;
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
  ) => Promise<SubagentAnnounceDeliveryResult | undefined>;
};

function missingVisibleReplyResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "direct",
    reason: "visible_reply_missing",
    error: "completion agent did not produce a visible reply",
  };
}

/** Reuses prepared facts; only the existing text-delivery owner may perform a send. */
export function createDirectAnnounceResponseClassifier(context: DirectAnnounceResponseContext) {
  const {
    params,
    parentOnly,
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
            disposition: "retryable",
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
      (automaticEvidence.mayHaveSent ||
        automaticEvidence.suppressionReason !== "no_visible_payload")
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
          ...missingVisibleReplyResult(),
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
          return missingVisibleReplyResult();
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
        return subagentDirectMessageCompletionRequiresMessageTool
          ? tryTextCompletionDirectDelivery(textCompletionDirectDeliveryKind).then(
              (textDelivery) => textDelivery ?? missingDelivery,
            )
          : missingDelivery;
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
          (params.requesterIsSubagent ||
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
        return missingVisibleReplyResult();
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
      !hasMessagingToolDelivery
    ) {
      return tryTextCompletionDirectDelivery(
        textCompletionDirectDeliveryKind,
      ).then<SubagentAnnounceDeliveryResult>((textDelivery) => {
        if (textDelivery) {
          return textDelivery;
        }
        if (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect) {
          return missingVisibleReplyResult();
        }
        return finishClassification();
      });
    }
    return finishClassification();
  };
}
