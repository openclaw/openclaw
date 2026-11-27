import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  type ChannelInboundTurnPlan,
  type DurableInboundReplyDeliveryParams,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  buildOutboundSessionContext,
  deliverInboundReplyWithMessageSendContext,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";

type ProviderDelivery = ChannelInboundTurnPlan<"provider_message_sending">["delivery"];
type ReplyParams = Pick<
  DurableInboundReplyDeliveryParams,
  "cfg" | "accountId" | "agentId" | "ctxPayload" | "payload"
> & {
  to: string;
  signal?: AbortSignal;
  info: Parameters<ProviderDelivery["deliverWithProviderMessageSending"]>[1];
};

/** Keep final runtime handoff and all payload planning with the shared owners. */
export async function deliverNextcloudTalkReply(params: ReplyParams) {
  const { cfg, accountId, agentId, ctxPayload, payload, info, to } = params;
  const final = await deliverInboundReplyWithMessageSendContext({
    cfg,
    channel: "nextcloud-talk",
    accountId,
    agentId,
    ctxPayload,
    payload,
    info,
    to,
  });
  if (final.status === "handled_visible" || final.status === "handled_no_send") {
    return final.delivery;
  }
  if (final.status === "failed") {
    throw final.error;
  }
  const send = await sendDurableMessageBatch({
    cfg,
    channel: "nextcloud-talk",
    accountId,
    to,
    payloads: [payload],
    replyToId: payload.replyToId,
    session: buildOutboundSessionContext({
      cfg,
      agentId,
      sessionKey: ctxPayload.SessionKey,
      policySessionKey: ctxPayload.RuntimePolicySessionKey,
      conversationType: ctxPayload.ChatType,
      requesterAccountId: accountId ?? ctxPayload.AccountId,
      requesterSenderId: ctxPayload.SenderId ?? ctxPayload.From,
      requesterSenderName: ctxPayload.SenderName,
      requesterSenderUsername: ctxPayload.SenderUsername,
      requesterSenderE164: ctxPayload.SenderE164,
    }),
    gatewayClientScopes: ctxPayload.GatewayClientScopes ?? [],
    signal: params.signal,
    onPlatformSendDispatch: info.onPlatformSendDispatch,
    assertDirectAdapterHandoff: info.assertPlatformSendAuthorized,
    // Nonfinal replies cannot outlive the producing run's send authority.
    skipQueue: true,
    durability: "best_effort",
  });
  if (send.status === "failed") {
    throw send.error;
  }
  const deliveryIntent = send.deliveryIntent
    ? {
        id: send.deliveryIntent.id,
        kind: "outbound_queue" as const,
        queuePolicy: send.deliveryIntent.queuePolicy,
      }
    : undefined;
  if (send.status === "suppressed") {
    return {
      visibleReplySent: false,
      receipt: send.receipt,
      suppression: { reason: send.reason },
      ...(deliveryIntent ? { deliveryIntent } : {}),
    };
  }
  const result = {
    ...createAcceptedChannelDeliveryResult({ results: [{ receipt: send.receipt }] }),
    ...(deliveryIntent ? { deliveryIntent } : {}),
  };
  if (send.status === "partial_failed") {
    throw createChannelPartialDeliveryError(send.error, result);
  }
  return result;
}
