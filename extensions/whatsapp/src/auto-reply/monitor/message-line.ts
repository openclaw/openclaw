// Whatsapp plugin module implements message line behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMergedWhatsAppAccountConfig } from "../../account-config.js";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSenderIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  formatInboundEnvelope,
  resolveMessagePrefix,
  type EnvelopeFormatOptions,
} from "./message-line.runtime.js";

function formatReplyTarget(replyTo: WhatsAppReplyContext | null) {
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

export function formatReplyContext(msg: AdmittedWebInboundMessage) {
  return formatReplyTarget(getReplyContext(msg));
}

export function buildInboundLine(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  accountId?: string;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
  visibleReplyTo?: WhatsAppReplyContext | null;
}) {
  const { cfg, msg, agentId, accountId, previousTimestamp, envelope } = params;
  // WhatsApp inbound prefix cascade: account > channel > legacy global
  // messages.messagePrefix > identity/defaults. When an account context is
  // available, resolve the prefix through the shared WhatsApp account merge so a
  // per-account `messagePrefix` override wins over the channel-level value
  // (mirroring how `responsePrefix` and `ackReaction` honor account/channel scope).
  // `messagePrefix` is WhatsApp-only (the global `messages.messagePrefix` is
  // deprecated in favor of `whatsapp.messagePrefix`), so this stays scoped to the
  // WhatsApp inbound path rather than widening a generic channel contract.
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: accountId
      ? resolveMergedWhatsAppAccountConfig({ cfg, accountId }).messagePrefix
      : cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0,
  });
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext =
    params.visibleReplyTo === undefined
      ? formatReplyContext(msg)
      : formatReplyTarget(params.visibleReplyTo);
  const baseLine = `${prefixStr}${msg.payload.body}${replyContext ? `\n\n${replyContext}` : ""}`;
  const sender = getSenderIdentity(msg);

  // Wrap with standardized envelope for the agent.
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: conversationKind === "group" ? conversationId : conversationId.replace(/^whatsapp:/, ""),
    timestamp: msg.event.timestamp,
    body: baseLine,
    chatType: conversationKind,
    sender: {
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.platform.fromMe,
  });
}
