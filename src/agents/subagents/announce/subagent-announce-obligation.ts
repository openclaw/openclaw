/** Completion policy. Transports execute these decisions without classifying them again. */
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../../../utils/message-channel.js";
import { normalizeAgentRunTerminalDeliverySnapshot } from "../../agent-run-terminal-delivery.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  getAutomaticDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleAgentPayload } from "../../embedded-agent-runner/message-visibility.js";
import {
  hasFailedSubagentNoOutputCompletion,
  hasVisibleCompletionResult,
} from "../../internal-event-contract.js";
import type { ReplyExpectation } from "../../reply-completion.js";
import {
  isIncompleteAnnounceAgentResultError,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import type {
  SubagentAnnounceDirectParams,
  SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import { resolveExactSubagentCompletionEvent } from "./subagent-announce-handoff.js";
import { inferDeliveryTargetChatType, type DeliveryContext } from "./subagent-announce-origin.js";

export type DirectAnnounceResponseContext = {
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
};

export type AnnounceResponseDecision =
  | SubagentAnnounceDeliveryResult
  | {
      action: "send-text";
      agentResult?: { payloads?: unknown };
      unavailable: AnnounceResponseDecision;
    };

export function resolveDirectAnnounceResponse(
  context: DirectAnnounceResponseContext,
  directAnnounceResponse: unknown,
): AnnounceResponseDecision {
  const {
    params,
    parentOnly,
    effectiveDirectOrigin,
    shouldDeliverAgentFinal,
    requiresMessageToolDelivery,
    isSubagentCompletion,
    hasSuccessfulTrustedSubagentNoOutputCompletion,
  } = context;
  if (isGatewayAgentRunPending(directAnnounceResponse)) {
    // The requester mailbox owns a private or settle turn that has not run yet.
    return parentOnly || params.sourceTool === "subagent_settle"
      ? { delivered: false, path: "queued", reason: "requester_turn_pending" }
      : { delivered: true, path: "direct" };
  }

  if (parentOnly) {
    return resolvePrivateCompletionDeliveryResult(
      asOptionalRecord(directAnnounceResponse),
      params.requesterIsSubagent ? undefined : effectiveDirectOrigin,
    );
  }
  const facts = readAnnounceResponseFacts(context, directAnnounceResponse);
  const {
    directAnnounceResult,
    hasFinalMessagingToolDelivery,
    hasMessagingToolDelivery,
    hasIntentionalSilentCompletionReply,
    hasVisibleNonSilentGatewayPayload,
    requesterCompletedSuccessfully,
    automaticEvidence,
    hasCompletionSideEffect,
    missingVisibleReplyResult,
    requiresAutomaticFinalReceipt,
    directDeliveryFailure,
    terminalDelivery,
    automaticFinalDelivered,
  } = facts;
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
    };
  }
  if (
    (isSubagentCompletion || params.sourceTool === "subagent_settle") &&
    facts.requesterFinished &&
    !hasVisibleNonSilentGatewayPayload
  ) {
    // Consuming child findings settles delivery; the parent owns any later answer.
    return buildRequesterCompletionDeliveryResult(
      hasFinalMessagingToolDelivery,
      directAnnounceResult?.meta?.finalAssistantVisibleText,
    );
  }
  if (
    requiresAutomaticFinalReceipt &&
    !hasFinalMessagingToolDelivery &&
    terminalDelivery?.status === "suppressed" &&
    // Only genuinely empty output can fall back; another payload may have
    // been sent or intentionally cancelled by policy.
    (automaticEvidence.mayHaveSent || automaticEvidence.suppressionReason !== "no_visible_payload")
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
      return { delivered: false, path: "queued", reason: "completion_handoff_pending" };
    }
  }

  if (
    params.expectsCompletionMessage &&
    shouldDeliverAgentFinal &&
    isSubagentCompletion &&
    !hasVisibleNonSilentGatewayPayload &&
    !hasIntentionalSilentCompletionReply &&
    !hasMessagingToolDelivery
  ) {
    return {
      action: "send-text",
      agentResult: directAnnounceResult ?? undefined,
      unavailable:
        hasSuccessfulTrustedSubagentNoOutputCompletion && !hasCompletionSideEffect
          ? missingVisibleReplyResult()
          : resolveVisibleAnnounceResponse(context, facts),
    };
  }
  return resolveVisibleAnnounceResponse(context, facts);
}

/** A failed requester run may still have a complete child result available to send. */
export function resolveFailedAnnounceResponse(
  context: Pick<
    DirectAnnounceResponseContext,
    | "params"
    | "shouldDeliverAgentFinal"
    | "subagentDirectMessageCompletionRequiresMessageTool"
    | "isSubagentCompletion"
  >,
  error: unknown,
): AnnounceResponseDecision {
  const failure: SubagentAnnounceDeliveryResult = {
    delivered: false,
    path: "direct",
    error: summarizeDeliveryError(error),
  };
  return context.params.expectsCompletionMessage &&
    (context.shouldDeliverAgentFinal ||
      context.subagentDirectMessageCompletionRequiresMessageTool) &&
    context.isSubagentCompletion &&
    isIncompleteAnnounceAgentResultError(error)
    ? { action: "send-text", unavailable: failure }
    : failure;
}

export type SubagentAnnounceFlowOutcome =
  | "delivered"
  | "session_queued"
  | "requester_waiting"
  | "undelivered";

/** A queued handoff is not a durable receipt for a detached completion. */
export function isDurableAnnounceDelivery(delivery: SubagentAnnounceDeliveryResult): boolean {
  if (!delivery.delivered) {
    return false;
  }
  if (delivery.path === "steered") {
    return true;
  }
  if (delivery.path !== "direct") {
    return false;
  }
  const phases = Array.isArray(delivery.phases) ? delivery.phases : undefined;
  return (
    !phases ||
    phases.some(
      (phase) => phase.phase === "direct-primary" && phase.delivered && phase.path === "direct",
    )
  );
}

/** Durable delivery evidence takes precedence over a later transport failure or handoff. */
export function resolveAnnounceCleanupOutcome(
  outcome: SubagentAnnounceFlowOutcome,
  facts: { delivered: boolean; handedOff: boolean },
): SubagentAnnounceFlowOutcome {
  return facts.delivered ? "delivered" : facts.handedOff ? "requester_waiting" : outcome;
}

type AnnounceCleanupAction =
  | "not_required"
  | "delivered"
  | "requester_waiting"
  | "session_queued"
  | "inspect_descendants"
  | "history"
  | "wait_for_descendants";

/** The history and queue adapters execute this plan; neither chooses a new outcome. */
export function planAnnounceCleanup(params: {
  expectsCompletionMessage: boolean | undefined;
  skipRequesterDelivery: boolean;
  outcome: SubagentAnnounceFlowOutcome;
  delivered: boolean;
  expired?: boolean;
  activeDescendants?: number;
}): AnnounceCleanupAction {
  if (params.expectsCompletionMessage === false || params.skipRequesterDelivery) {
    return "not_required";
  }
  if (params.outcome === "delivered") {
    return "delivered";
  }
  if (params.outcome === "requester_waiting") {
    return "requester_waiting";
  }
  if (params.outcome === "session_queued") {
    return "session_queued";
  }
  if (params.delivered) {
    return "delivered";
  }
  if (params.expired || (params.activeDescendants !== undefined && params.activeDescendants <= 0)) {
    return "history";
  }
  return params.activeDescendants === undefined ? "inspect_descendants" : "wait_for_descendants";
}

/** A late failed attempt cannot reclaim delivery already settled or transferred. */
export function acceptsAnnounceDeliveryResult(
  delivery: SubagentAnnounceDeliveryResult,
  facts: { delivered: boolean; handedOff: boolean },
): boolean {
  return !facts.delivered && (delivery.delivered || !facts.handedOff);
}

export function isGatewayAgentRunPending(response: unknown): boolean {
  return isNonTerminalAgentRunStatus(asOptionalObjectRecord(response)?.status);
}

export function resolvePrivateCompletionDeliveryResult(
  response: Record<string, unknown> | undefined,
  origin?: DeliveryContext,
): SubagentAnnounceDeliveryResult {
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(response);
  if (outcome?.reason === "cancelled" && outcome.stopReason !== "restart") {
    return {
      delivered: false,
      path: "direct",
      reason: "delivery_suppressed",
      error: "private requester continuation was cancelled",
    };
  }
  // Successful internal consumption may be silent or start the next child.
  // Queue acceptance alone is not consumption, and no external receipt is owed.
  const delivery: SubagentAnnounceDeliveryResult =
    response?.status === "ok" && response.inputProcessingCompleted === true
      ? { delivered: true, path: "direct" }
      : {
          delivered: false,
          path: "direct",
          reason: "completion_handoff_pending",
          error: "private requester turn has not completed successfully",
        };
  const result = getGatewayAgentResult(response);
  if (
    delivery.delivered &&
    origin?.channel &&
    origin.to &&
    result &&
    result.meta?.yielded !== true &&
    result.meta?.continuationPending !== true &&
    hasMessagingToolDeliveryToSource(result, origin, { requireFinalReply: true })
  ) {
    delivery.requesterVisibleFinalDelivered = true;
  }
  return delivery;
}

function buildRequesterCompletionDeliveryResult(
  finalCommitted: boolean,
  text: unknown,
): SubagentAnnounceDeliveryResult {
  const finalAssistantVisibleText =
    finalCommitted && typeof text === "string" ? truncateUtf16Safe(text.trim(), 12_000) : "";
  return {
    delivered: true,
    path: "direct",
    // A canceled partial payload or accepted handoff is not a visible final receipt.
    ...(finalCommitted ? { requesterVisibleFinalDelivered: true } : {}),
    ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
  };
}

/** Prepare one reply obligation before either steering or starting a requester turn. */
export function planDirectAnnounceDelivery(
  params: SubagentAnnounceDirectParams,
  facts: {
    cfg: OpenClawConfig;
    sourceToolId: string;
    canonicalRequesterSessionKey: string;
    requesterEntry: SessionEntry | undefined;
    requesterSessionOrigin: DeliveryContext | undefined;
    effectiveDirectOrigin: DeliveryContext | undefined;
    deliveryTarget: { deliver: boolean; channel?: string; to?: string; threadId?: string };
    participating: boolean;
  },
) {
  const {
    cfg,
    sourceToolId,
    canonicalRequesterSessionKey,
    requesterEntry,
    requesterSessionOrigin,
    effectiveDirectOrigin,
    deliveryTarget,
    participating,
  } = facts;
  const parentOnly = params.completionTarget === "parent";
  const isSubagentCompletion = sourceToolId === "subagent_announce";
  const trustedCompletionEvent = resolveExactSubagentCompletionEvent({
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: params.sourceSessionKey,
      sourceTool: sourceToolId,
    },
    internalEvents: params.internalEvents,
  });
  const hasRequiredSubagentNoOutputCompletion =
    params.expectsCompletionMessage &&
    isSubagentCompletion &&
    ((trustedCompletionEvent !== undefined &&
      !hasVisibleCompletionResult(trustedCompletionEvent)) ||
      hasFailedSubagentNoOutputCompletion(params.internalEvents));
  const hasSuccessfulTrustedSubagentNoOutputCompletion =
    hasRequiredSubagentNoOutputCompletion && trustedCompletionEvent?.status === "ok";
  const subagentDirectMessageCompletionRequiresMessageTool =
    params.expectsCompletionMessage &&
    isSubagentCompletion &&
    deliveryTarget.deliver &&
    isDirectMessageDeliveryTarget(deliveryTarget, canonicalRequesterSessionKey);
  const requiresMessageToolDelivery =
    subagentDirectMessageCompletionRequiresMessageTool ||
    (!parentOnly &&
      params.expectsCompletionMessage &&
      completionRequiresMessageToolDelivery({
        cfg,
        requesterSessionKey: params.requesterSessionKey,
        targetRequesterSessionKey: canonicalRequesterSessionKey,
        requesterEntry,
        directOrigin: effectiveDirectOrigin,
        requesterSessionOrigin,
      }));
  return {
    isSubagentCompletion,
    trustedCompletionEvent,
    hasRequiredSubagentNoOutputCompletion,
    hasSuccessfulTrustedSubagentNoOutputCompletion,
    subagentDirectMessageCompletionRequiresMessageTool,
    requiresMessageToolDelivery,
    shouldDeliverAgentFinal:
      !participating && deliveryTarget.deliver && !requiresMessageToolDelivery,
    completionSourceReplyDeliveryMode: parentOnly
      ? ("automatic" as const)
      : requiresMessageToolDelivery
        ? ("message_tool_only" as const)
        : undefined,
  };
}

function readAnnounceResponseFacts(
  context: DirectAnnounceResponseContext,
  directAnnounceResponse: unknown,
) {
  const {
    params,
    replyExpectation,
    deliveryTarget,
    shouldDeliverAgentFinal,
    requiresMessageToolDelivery,
  } = context;
  const directAnnounceResult = getGatewayAgentResult(directAnnounceResponse);
  const directAnnounceRecord = asOptionalRecord(directAnnounceResponse);
  const effectiveReplyExpectation =
    directAnnounceResult?.meta?.terminalReplyExpectation === "result-required"
      ? "result-required"
      : replyExpectation;
  const hasFinalMessagingToolDelivery = Boolean(
    directAnnounceResult &&
    hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
      requireFinalReply: true,
    }),
  );
  const hasMessagingToolDelivery = Boolean(
    directAnnounceResult && hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
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
  const missingVisibleReplyResult = (): SubagentAnnounceDeliveryResult =>
    requesterCompletedSuccessfully
      ? buildRequesterCompletionDeliveryResult(
          false,
          directAnnounceResult?.meta?.finalAssistantVisibleText,
        )
      : {
          delivered: false,
          path: "direct",
          error: summarizeDeliveryError(directAnnounceResult?.meta?.error),
        };
  const requiresSettleReply = params.sourceTool === "subagent_settle";
  const requesterFinished =
    requesterCompletedSuccessfully &&
    directAnnounceResult?.meta?.yielded !== true &&
    directAnnounceResult?.meta?.continuationPending !== true;
  const acceptsIntentionalSilentCompletion =
    effectiveReplyExpectation !== "result-required" &&
    !requiresSettleReply &&
    requesterFinished &&
    hasIntentionalSilentCompletionReply;
  const requiresAutomaticFinalReceipt =
    shouldDeliverAgentFinal &&
    (params.expectsCompletionMessage || params.sourceTool === "subagent_settle");
  const directDeliveryFailure =
    (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
      ? getAgentCommandDeliveryFailure(directAnnounceResult)
      : undefined;
  const terminalDelivery = normalizeAgentRunTerminalDeliverySnapshot(
    directAnnounceResult?.deliveryStatus,
  );
  const automaticFinalDelivered =
    terminalDelivery?.status === "sent" && terminalDelivery.resultCount > 0;

  return {
    directAnnounceResult,
    directAnnounceRecord,
    effectiveReplyExpectation,
    hasFinalMessagingToolDelivery,
    hasMessagingToolDelivery,
    hasIntentionalSilentCompletionReply,
    hasVisibleNonSilentGatewayPayload,
    requesterCompletedSuccessfully,
    requesterFinished,
    automaticEvidence,
    hasCompletionSideEffect,
    missingVisibleReplyResult,
    requiresSettleReply,
    acceptsIntentionalSilentCompletion,
    requiresAutomaticFinalReceipt,
    directDeliveryFailure,
    terminalDelivery,
    automaticFinalDelivered,
  };
}

function resolveVisibleAnnounceResponse(
  context: DirectAnnounceResponseContext,
  facts: ReturnType<typeof readAnnounceResponseFacts>,
): AnnounceResponseDecision {
  const {
    params,
    requiresMessageToolDelivery,
    subagentDirectMessageCompletionRequiresMessageTool,
    hasRequiredSubagentNoOutputCompletion,
    hasSuccessfulTrustedSubagentNoOutputCompletion,
    shouldDeliverAgentFinal,
    requesterSessionBound,
    effectiveDirectOrigin,
    requesterSessionOrigin,
  } = context;
  const {
    directAnnounceResult,
    directAnnounceRecord,
    hasMessagingToolDelivery,
    hasFinalMessagingToolDelivery,
    hasIntentionalSilentCompletionReply,
    hasVisibleNonSilentGatewayPayload,
    requesterCompletedSuccessfully,
    missingVisibleReplyResult,
    automaticFinalDelivered,
    acceptsIntentionalSilentCompletion,
    effectiveReplyExpectation,
    requiresSettleReply,
    hasCompletionSideEffect,
  } = facts;
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
      ? {
          action: "send-text",
          agentResult: directAnnounceResult ?? undefined,
          unavailable: missingVisibleReplyResult(),
        }
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
        (shouldDeliverAgentFinal || (!requiresMessageToolDelivery && !hasCompletionSideEffect))))
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
}

export function isDirectMessageDeliveryTarget(
  target: { channel?: string; to?: string; threadId?: string },
  requesterSessionKey: string,
): boolean {
  if (target.threadId) {
    return false;
  }
  const targetChatType = inferDeliveryTargetChatType(target);
  if (targetChatType) {
    return targetChatType === "direct";
  }
  return deriveSessionChatTypeFromKey(requesterSessionKey) === "direct";
}

function hasMessagingToolDeliveryToSource(
  result: {
    didDeliverSourceReplyViaMessageTool?: unknown;
    didSendViaMessagingTool?: unknown;
    messagingToolSentTargets?: unknown;
    messagingToolSourceReplyPayloads?: unknown;
  },
  deliveryTarget: Parameters<typeof sourceDeliveryTargetsMatch>[1],
  options?: { requireFinalReply?: boolean },
): boolean {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets = targets.filter((target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      return false;
    }
    // SAFETY: Agent runners produce MessagingToolSend records; the guard excludes non-records.
    const record = target as Parameters<typeof sourceDeliveryTargetsMatch>[0];
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    return sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget);
  });
  if (options?.requireFinalReply) {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  }
  if (
    hasCommittedSourceReplyDeliveryEvidence(result) ||
    hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
  ) {
    return true;
  }

  if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
    return hasMessagingToolDeliveryEvidence(result);
  }

  return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
}
