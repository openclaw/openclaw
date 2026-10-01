import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply.js";
import type {
  sendDurableMessageBatchCore,
  SerializedDurableMessagePayloadOutcome,
} from "../../channels/message/runtime.js";
import { serializeDurableMessagePayloadOutcomes } from "../../channels/message/runtime.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { projectOutboundPayloadPlanForJson } from "../../infra/outbound/payloads.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";

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
  payloadOutcomes?: SerializedDurableMessagePayloadOutcome[];
};

export type AgentCommandDeliveryResult = Pick<
  EmbeddedAgentRunResult,
  | "didDeliverSourceReplyViaMessageTool"
  | "sourceReplyDelivered"
  | "sourceReplyDeliveryState"
  | "messagingToolSourceReplyPayloads"
  | "meta"
  | "didSendViaMessagingTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "acceptedSessionSpawns"
  | "requesterContinuationSettled"
  | "successfulCronAdds"
> & {
  payloads: ReturnType<typeof projectOutboundPayloadPlanForJson>;
  didSendDeterministicApprovalPrompt?: true;
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

type DurableSendResult = Awaited<ReturnType<typeof sendDurableMessageBatchCore>>;

export function deliveryStatusFromDurableSend(send: DurableSendResult): AgentCommandDeliveryStatus {
  const payloadOutcomes = serializeDurableMessagePayloadOutcomes(send.payloadOutcomes, {
    includeHookEffect: true,
  });
  const status = {
    requested: true,
    attempted: true,
    status: send.status,
  } as const;
  switch (send.status) {
    case "sent":
      return {
        ...status,
        succeeded: true,
        resultCount: send.results.length,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "suppressed":
      return {
        ...status,
        succeeded: true,
        reason: send.reason,
        resultCount: 0,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "partial_failed":
      return {
        ...status,
        succeeded: "partial",
        error: true,
        errorMessage: formatErrorMessage(send.error),
        resultCount: send.results.length,
        sentBeforeError: true,
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
    case "failed":
      return {
        ...status,
        succeeded: false,
        error: true,
        errorMessage: formatErrorMessage(send.error),
        ...(send.stage ? { reason: send.stage } : {}),
        ...(payloadOutcomes ? { payloadOutcomes } : {}),
      };
  }
  const exhaustive: never = send;
  return exhaustive;
}

export function preDeliveryFailureStatus(reason: string): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "failed",
    succeeded: false,
    error: true,
    reason,
  };
}

export function noVisiblePayloadStatus(
  reason?: NormalizeReplySkipReason,
): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "suppressed",
    succeeded: true,
    reason: reason === "channel_transform" ? reason : "no_visible_payload",
    resultCount: 0,
  };
}

/**
 * Payloads the source may receive. A tool-only source gets only host-granted ones
 * (diagnostics, media); a host-owned turn may also keep runtime error payloads out of it.
 */
export function selectSourceDeliverablePayloads<T extends ReplyPayload>(
  payloads: T[],
  opts: {
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    internalDeliverySuppressErrors?: boolean;
  },
): T[] {
  const deliverable = opts.internalDeliverySuppressErrors
    ? payloads.filter((payload) => payload.isError !== true)
    : payloads;
  return opts.sourceReplyDeliveryMode === "message_tool_only"
    ? deliverable.filter(
        (payload) =>
          getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
      )
    : deliverable;
}
