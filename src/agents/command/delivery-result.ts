import type { SerializedDurableMessagePayloadOutcome } from "../../channels/message/runtime.js";
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
