import { resolveMessagePrefix } from "../../../../../src/agents/identity.js";
import {
  formatInboundEnvelope,
  type EnvelopeFormatOptions,
} from "../../../../../src/auto-reply/envelope.js";
import type { loadConfig } from "../../../../../src/config/config.js";
import { resolveWhatsAppAccount } from "../../accounts.js";
import type { WebInboundMsg } from "../types.js";

export function formatReplyContext(msg: WebInboundMsg) {
  if (!msg.replyToBody) {
    return null;
  }
  const sender = msg.replyToSender ?? "unknown sender";
  const idPart = msg.replyToId ? ` id:${msg.replyToId}` : "";
  return `[Replying to ${sender}${idPart}]\n${msg.replyToBody}\n[/Replying]`;
}

export function buildInboundLine(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  accountId?: string;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
}) {
  const { cfg, msg, agentId, previousTimestamp, envelope } = params;
  // Resolve account-level messagePrefix and allowFrom for multi-account setups.
  const account = resolveWhatsAppAccount({ cfg, accountId: params.accountId });
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: account.messagePrefix ?? cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (account.allowFrom?.length ?? 0) > 0,
  });
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext = formatReplyContext(msg);
  const baseLine = `${prefixStr}${msg.body}${replyContext ? `\n\n${replyContext}` : ""}`;

  // Wrap with standardized envelope for the agent.
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
    timestamp: msg.timestamp,
    body: baseLine,
    chatType: msg.chatType,
    sender: {
      name: msg.senderName,
      e164: msg.senderE164,
      id: msg.senderJid,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.fromMe,
  });
}
