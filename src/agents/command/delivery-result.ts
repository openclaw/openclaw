import {
  sendDurableMessageBatchCore,
  serializeDurableMessagePayloadOutcomes,
  type SerializedDurableMessagePayloadOutcome,
} from "../../channels/message/runtime.js";
import { isDeliveryRecoveryOwnedRetry } from "../../infra/delivery-recovery.shared.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { projectOutboundPayloadPlanForJson } from "../../infra/outbound/payloads.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";
import type { MessagingToolSend } from "../embedded-agent-messaging.types.js";
import type {
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "../embedded-agent-runner/types.js";

/** Aggregate delivery status for an agent command result. */
export type AgentCommandDeliveryStatus = {
  requested: true;
  attempted: boolean;
  status: "sent" | "suppressed" | "partial_failed" | "failed";
  /** `partial` means at least one payload was sent before a later payload failed. */
  succeeded: true | false | "partial";
  error?: true;
  errorMessage?: string;
  /** Free-form lowercase_snake reason from durable delivery or preflight validation. */
  reason?: string;
  resultCount?: number;
  sentBeforeError?: true;
  /** Set only when the durable queue proved it retained the failed attempt for recovery. */
  queueCustody?: "held";
  payloadOutcomes?: SerializedDurableMessagePayloadOutcome[];
};

export type DurableSendResult = Awaited<ReturnType<typeof sendDurableMessageBatchCore>>;

/** Derives the aggregate delivery status from a durable send batch result. */
export function deliveryStatusFromDurableSend(send: DurableSendResult): AgentCommandDeliveryStatus {
  const payloadOutcomes = serializeDurableMessagePayloadOutcomes(send.payloadOutcomes, {
    includeHookEffect: true,
  });
  switch (send.status) {
    case "sent":
      return {
        requested: true,
        attempted: true,
        status: "sent",
        succeeded: true,
        resultCount: send.results.length,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "suppressed":
      return {
        requested: true,
        attempted: true,
        status: "suppressed",
        succeeded: true,
        reason: send.reason,
        resultCount: 0,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "partial_failed":
      return {
        requested: true,
        attempted: true,
        status: "partial_failed",
        succeeded: "partial",
        error: true,
        errorMessage: formatErrorMessage(send.error),
        resultCount: send.results.length,
        sentBeforeError: true,
        ...(isDeliveryRecoveryOwnedRetry(send.error) ? { queueCustody: "held" as const } : {}),
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "failed":
      return {
        requested: true,
        attempted: true,
        status: "failed",
        succeeded: false,
        error: true,
        errorMessage: formatErrorMessage(send.error),
        ...(send.stage ? { reason: send.stage } : {}),
        ...(isDeliveryRecoveryOwnedRetry(send.error) ? { queueCustody: "held" as const } : {}),
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
  }
  const exhaustive: never = send;
  return exhaustive;
}

/** Agent command result after payload normalization and optional delivery. */
export type AgentCommandDeliveryResult = Pick<
  EmbeddedAgentRunResult,
  | "didDeliverSourceReplyViaMessageTool"
  | "sourceReplyDelivered"
  | "sourceReplyDeliveryState"
  | "messagingToolSourceReplyPayloads"
> & {
  payloads: ReturnType<typeof projectOutboundPayloadPlanForJson>;
  meta: EmbeddedAgentRunMeta;
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  didSendDeterministicApprovalPrompt?: true;
  acceptedSessionSpawns?: NonNullable<EmbeddedAgentRunResult["acceptedSessionSpawns"]>;
  requesterContinuationSettled?: true;
  successfulCronAdds?: number;
  deliverySucceeded?: boolean;
  deliveryStatus?: AgentCommandDeliveryStatus;
};

function hasNonEmptyArray<T>(value: T[] | undefined): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

export function buildDeliveryResult(params: {
  payloads: AgentCommandDeliveryResult["payloads"];
  meta: AgentCommandDeliveryResult["meta"];
  result: EmbeddedAgentRunResult;
  deliverySucceeded?: boolean;
  deliveryStatus?: AgentCommandDeliveryStatus;
}): AgentCommandDeliveryResult {
  const successfulCronAdds = params.result.successfulCronAdds;
  const hasSuccessfulCronAdds =
    typeof successfulCronAdds === "number" &&
    Number.isFinite(successfulCronAdds) &&
    successfulCronAdds > 0;
  return {
    payloads: params.payloads,
    meta: params.meta,
    ...(params.result.didSendViaMessagingTool === true ? { didSendViaMessagingTool: true } : {}),
    ...(params.result.didDeliverSourceReplyViaMessageTool === true
      ? { didDeliverSourceReplyViaMessageTool: true }
      : {}),
    ...(params.result.sourceReplyDelivered ? { sourceReplyDelivered: true as const } : {}),
    ...(params.result.sourceReplyDeliveryState !== undefined
      ? { sourceReplyDeliveryState: params.result.sourceReplyDeliveryState }
      : {}),
    ...(hasNonEmptyArray(params.result.messagingToolSourceReplyPayloads)
      ? { messagingToolSourceReplyPayloads: params.result.messagingToolSourceReplyPayloads }
      : {}),
    ...(hasNonEmptyStringArray(params.result.messagingToolSentTexts)
      ? { messagingToolSentTexts: params.result.messagingToolSentTexts }
      : {}),
    ...(hasNonEmptyStringArray(params.result.messagingToolSentMediaUrls)
      ? { messagingToolSentMediaUrls: params.result.messagingToolSentMediaUrls }
      : {}),
    ...(hasNonEmptyArray(params.result.messagingToolSentTargets)
      ? { messagingToolSentTargets: params.result.messagingToolSentTargets }
      : {}),
    ...(params.result.didSendDeterministicApprovalPrompt === true
      ? { didSendDeterministicApprovalPrompt: true }
      : {}),
    ...(hasNonEmptyArray(params.result.acceptedSessionSpawns)
      ? { acceptedSessionSpawns: params.result.acceptedSessionSpawns }
      : {}),
    ...(params.result.requesterContinuationSettled === true
      ? { requesterContinuationSettled: true as const }
      : {}),
    ...(hasSuccessfulCronAdds ? { successfulCronAdds } : {}),
    ...(params.deliverySucceeded !== undefined
      ? { deliverySucceeded: params.deliverySucceeded }
      : {}),
    ...(params.deliveryStatus ? { deliveryStatus: params.deliveryStatus } : {}),
  };
}
