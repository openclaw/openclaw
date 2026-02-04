import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { sendDailyflowsMessage } from "./send.js";
import { getDailyflowsRuntime } from "./runtime.js";
import type { DailyflowsInboundMessage, DailyflowsWebhookPayload } from "./types.js";

function formatInboundBody(message: DailyflowsInboundMessage): string {
  const text = message.text?.trim() ?? "";
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return text;
  }
  const attachmentLines = attachments.map((item) => `Attachment: ${item.url} (${item.type})`);
  if (!text) {
    return attachmentLines.join("\n");
  }
  return `${text}\n\n${attachmentLines.join("\n")}`;
}

export async function handleDailyflowsInbound(params: {
  payload: DailyflowsWebhookPayload;
  cfg: OpenClawConfig;
  runtime: { error?: (msg: string) => void };
}): Promise<void> {
  const { payload, cfg, runtime } = params;
  const core = getDailyflowsRuntime();
  const message = payload.message;
  const accountId = payload.accountId ?? "default";
  const chatType = message.chatType ?? "direct";
  const conversationId = message.conversationId || message.senderId;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const conversationName = message.conversationName;
  const bodyText = formatInboundBody(message);
  if (!bodyText.trim()) {
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "dailyflows",
    accountId,
    peer: {
      kind: chatType === "group" ? "group" : "dm",
      id: conversationId,
    },
  });

  const fromLabel =
    chatType === "group"
      ? `room:${conversationName || conversationId}`
      : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Dailyflows",
    from: fromLabel,
    timestamp: payload.occurredAt ?? Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: bodyText,
    CommandBody: bodyText,
    From: chatType === "group" ? `dailyflows:room:${conversationId}` : `dailyflows:${senderId}`,
    To: `dailyflows:${conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: chatType === "group" ? conversationName || conversationId : undefined,
    Provider: "dailyflows",
    Surface: "dailyflows",
    MessageSid: message.messageId,
    Timestamp: payload.occurredAt ?? Date.now(),
    OriginatingChannel: "dailyflows",
    OriginatingTo: `dailyflows:${conversationId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`dailyflows: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (reply) => {
        await sendDailyflowsMessage({
          cfg,
          payload: {
            accountId,
            conversationId,
            text: reply.text ?? "",
            replyToId: message.messageId,
            attachments: reply.mediaUrls?.length
              ? reply.mediaUrls.map((url) => ({ type: "file", url }))
              : reply.mediaUrl
                ? [{ type: "file", url: reply.mediaUrl }]
                : undefined,
          },
        });
      },
      onError: (err, info) => {
        runtime.error?.(`dailyflows ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}
