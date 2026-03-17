import { jidToE164, normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import type { WebInboundMsg } from "../types.js";

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function resolveConversationId(
  msg: Pick<WebInboundMsg, "conversationId" | "from" | "chatId">,
): string {
  return firstNonEmpty(msg.conversationId, msg.from, msg.chatId) ?? "unknown";
}

export function resolveDirectPeerId(
  msg: Pick<WebInboundMsg, "senderE164" | "conversationId" | "from" | "chatId">,
): string | null {
  if (msg.senderE164) {
    return normalizeE164(msg.senderE164) ?? msg.senderE164;
  }
  const candidate = firstNonEmpty(msg.from, msg.conversationId, msg.chatId);
  if (!candidate) {
    return null;
  }
  if (candidate.includes("@")) {
    return jidToE164(candidate) ?? candidate;
  }
  return normalizeE164(candidate) ?? candidate;
}

export function resolvePeerId(msg: WebInboundMsg) {
  if (msg.chatType === "group") {
    return resolveConversationId(msg);
  }
  return resolveDirectPeerId(msg) ?? resolveConversationId(msg);
}
