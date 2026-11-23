/** Interprets direct announcement responses and the existing text-fallback receipt. */
import {
  classifyAgentRunTerminalOutcome,
  resolveAgentRunWaitTerminalFacts,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
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
import { classifyAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";
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
  tryTextCompletionDirectDelivery: (agentResult?: {
    payloads?: unknown;
  }) => Promise<SubagentAnnounceDeliveryResult | undefined>;
};

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
    const effectiveReplyExpectation =
      directAnnounceResult?.meta?.terminalReplyExpectation === "result-required"
        ? "result-required"
        : replyExpectation;
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
    const requesterCompletedSuccessfully =
      directAnnounceRecord?.status === "ok" &&
      !directAnnounceResult?.meta?.error &&
      !directAnnounceResult?.meta?.aborted;
    const automaticEvidence = getAutomaticDeliveryEvidence(directAnnounceResult ?? {});
    const hasCompletionSideEffect = Boolean(
      directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
    );
    // Consuming child findings settles delivery; the parent owns any later answer.
    const missingVisibleReplyResult = (): SubagentAnnounceDeliveryResult => {
      if (requesterCompletedSuccessfully) {
        return buildRequesterCompletionDeliveryResult(
          false,
          directAnnounceResult?.meta?.finalAssistantVisibleText,
        );
      }
      const terminal = resolveAgentRunWaitTerminalFacts(directAnnounceRecord ?? {});
      const outcome = terminal && classifyAgentRunTerminalOutcome(terminal);
      const interruption =
        directAnnounceResult?.meta?.aborted === true || outcome === "cancellation"
          ? "requester_aborted"
          : outcome === "timeout"
            ? "requester_timed_out"
            : undefined;
      const failure = classifyAnnounceDeliveryError(directAnnounceResult?.meta?.error, {
        interruption,
        restartInterrupted: terminal?.stopReason === "restart",
        replaySafe: directAnnounceRecord?.replaySafe === true && !automaticEvidence.mayHaveSent,
      });
      return automaticEvidence.mayHaveSent ? { ...failure, disposition: "ambiguous" } : failure;
    };
    const requiresSettleReply = params.sourceTool === "subagent_settle";
    const acceptsIntentionalSilentCompletion =
      effectiveReplyExpectation !== "result-required" &&
      !requiresSettleReply &&
      requesterCompletedSuccessfully &&
      hasIntentionalSilentCompletionReply &&
      directAnnounceResult?.meta?.yielded !== true &&
      directAnnounceResult?.meta?.continuationPending !== true;
    const requiresAutomaticFinalReceipt =
      shouldDeliverAgentFinal &&
      (params.expectsCompletionMessage || params.sourceTool === "subagent_settle");
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
        // A completed turn's answer did not reach the requester's channel.
        ...(requesterCompletedSuccessfully ? { finalAssistantVisibleText: "" } : {}),
        ...(automaticEvidence.mayHaveSent ? { disposition: "ambiguous" as const } : {}),
      };
    }
    if (
      (isSubagentCompletion || params.sourceTool === "subagent_settle") &&
      requesterCompletedSuccessfully &&
      !hasVisibleNonSilentGatewayPayload &&
      directAnnounceResult?.meta?.yielded !== true &&
      directAnnounceResult?.meta?.continuationPending !== true
    ) {
      // Consuming child findings settles delivery; the parent owns any later answer.
      return buildRequesterCompletionDeliveryResult(
        hasFinalMessagingToolDelivery,
        directAnnounceResult?.meta?.finalAssistantVisibleText,
      );
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
        return missingVisibleReplyResult();
      }
      return {
        delivered: false,
        path: "direct",
        reason: automaticEvidence.mayHaveSent ? undefined : "delivery_suppressed",
        // Consumption cannot credit a completed answer with an unconfirmed channel receipt.
        ...(requesterCompletedSuccessfully ? { finalAssistantVisibleText: "" } : {}),
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
    const finishClassification = ():
      | SubagentAnnounceDeliveryResult
      | Promise<SubagentAnnounceDeliveryResult> => {
      if (
        params.expectsCompletionMessage &&
        requiresMessageToolDelivery &&
        !hasMessagingToolDelivery &&
        (!hasIntentionalSilentCompletionReply ||
          subagentDirectMessageCompletionRequiresMessageTool ||
          hasRequiredSubagentNoOutputCompletion)
      ) {
        // The parent answered without the message tool: send the result text where we can.
        return subagentDirectMessageCompletionRequiresMessageTool &&
          !hasSuccessfulTrustedSubagentNoOutputCompletion &&
          !hasIntentionalSilentCompletionReply
          ? tryTextCompletionDirectDelivery(directAnnounceResult ?? undefined).then(
              (textDelivery) => textDelivery ?? missingVisibleReplyResult(),
            )
          : missingVisibleReplyResult();
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
        (effectiveReplyExpectation === "result-required" ||
          requiresSettleReply ||
          (params.expectsCompletionMessage &&
            (shouldDeliverAgentFinal ||
              (!requiresMessageToolDelivery && !hasCompletionSideEffect))))
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
      !hasIntentionalSilentCompletionReply &&
      !hasMessagingToolDelivery
    ) {
      return tryTextCompletionDirectDelivery(directAnnounceResult ?? undefined).then(
        (textDelivery) =>
          textDelivery ??
          (hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect
            ? missingVisibleReplyResult()
            : finishClassification()),
      );
    }
    return finishClassification();
  };
}
