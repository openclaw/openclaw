import { jidToE164, normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import type { WebInboundMsg } from "../types.js";

export function resolvePeerId(msg: WebInboundMsg) {
  if (msg.chatType === "group") {
    return msg.conversationId ?? msg.from ?? "unknown";
  }
  if (msg.senderE164) {
    return normalizeE164(msg.senderE164) ?? msg.senderE164;
  }
  const directPeerSource = msg.from ?? msg.conversationId;
  if (!directPeerSource) {
    return "unknown";
  }
  if (directPeerSource.includes("@")) {
    return jidToE164(directPeerSource) ?? directPeerSource;
  }
  return normalizeE164(directPeerSource) ?? directPeerSource;
}
