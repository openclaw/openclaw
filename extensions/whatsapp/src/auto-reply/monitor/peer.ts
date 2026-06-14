// Whatsapp plugin module implements peer behavior.
import { getSenderIdentity } from "../../identity.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { jidToE164, normalizeE164 } from "../../text-runtime.js";

export function resolvePeerId(msg: WebInboundMessage) {
  if (msg.chatType === "group") {
    return msg.conversationId ?? msg.from;
  }
  const sender = getSenderIdentity(msg);
  if (sender.e164) {
    return normalizeE164(sender.e164) ?? sender.e164;
  }
  if (msg.from.includes("@")) {
    return jidToE164(msg.from) ?? msg.from;
  }
  return normalizeE164(msg.from) ?? msg.from;
}
