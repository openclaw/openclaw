import {
  resolveAckReaction,
  shouldAckReactionForWhatsApp,
} from "openclaw/plugin-sdk/channel-feedback";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

export function maybeSendAckReaction(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}) {
  if (!params.msg.id) {
    return;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  // When ackReaction is not configured at all, preserve the existing no-reaction default.
  // When it is configured (even without an explicit emoji), use resolveAckReaction so the
  // agent identity emoji is used as a fallback — enabling per-agent ack reactions.
  const emoji =
    ackConfig !== undefined
      ? resolveAckReaction(params.cfg, params.agentId, {
          channel: "whatsapp",
          accountId: params.accountId,
        })
      : "";
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? resolveGroupActivationFor({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;
  const shouldSendReaction = () =>
    shouldAckReactionForWhatsApp({
      emoji,
      isDirect: params.msg.chatType === "direct",
      isGroup: params.msg.chatType === "group",
      directEnabled,
      groupMode,
      wasMentioned: params.msg.wasMentioned === true,
      groupActivated: activation === "always",
    });

  if (!shouldSendReaction()) {
    return;
  }

  params.info(
    { chatId: params.msg.chatId, messageId: params.msg.id, emoji },
    "sending ack reaction",
  );
  sendReactionWhatsApp(params.msg.chatId, params.msg.id, emoji, {
    verbose: params.verbose,
    fromMe: false,
    participant: params.msg.senderJid,
    accountId: params.accountId,
  }).catch((err) => {
    params.warn(
      {
        error: formatError(err),
        chatId: params.msg.chatId,
        messageId: params.msg.id,
      },
      "failed to send ack reaction",
    );
    logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`);
  });
}
