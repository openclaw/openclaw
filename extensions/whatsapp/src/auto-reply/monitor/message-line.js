import { resolveMessagePrefix } from "../../../../../src/agents/identity.js";
import {
  formatInboundEnvelope
} from "../../../../../src/auto-reply/envelope.js";
function formatReplyContext(msg) {
  if (!msg.replyToBody) {
    return null;
  }
  const sender = msg.replyToSender ?? "unknown sender";
  const idPart = msg.replyToId ? ` id:${msg.replyToId}` : "";
  return `[Replying to ${sender}${idPart}]
${msg.replyToBody}
[/Replying]`;
}
function buildInboundLine(params) {
  const { cfg, msg, agentId, previousTimestamp, envelope } = params;
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0
  });
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext = formatReplyContext(msg);
  const baseLine = `${prefixStr}${msg.body}${replyContext ? `

${replyContext}` : ""}`;
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
    timestamp: msg.timestamp,
    body: baseLine,
    chatType: msg.chatType,
    sender: {
      name: msg.senderName,
      e164: msg.senderE164,
      id: msg.senderJid
    },
    previousTimestamp,
    envelope,
    fromMe: msg.fromMe
  });
}
export {
  buildInboundLine,
  formatReplyContext
};
