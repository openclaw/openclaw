import "./conversation-id-core.js";
import { hasPositiveIMessageChatId, normalizeIMessageHandle } from "./targets.js";
export {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
  resolveIMessageConversationIdFromTarget,
} from "./conversation-id-core.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve a durable group anchor id for an inbound iMessage group.
 *
 * Prefers a positive `chat_id`, then falls back to `chat_guid` / `chat_identifier`
 * so group messages from bridges that only emit a guid-style anchor are routed
 * instead of silently dropped. Mirrors the "usable anchor" notion owned by
 * `monitor/conversation-repair.ts`; kept here so the inbound gate and the
 * conversation binding owner agree on what counts as an anchored group.
 */
export function resolveIMessageGroupAnchorId(params: {
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string | undefined {
  if (hasPositiveIMessageChatId(params.chatId)) {
    return String(params.chatId);
  }
  if (isNonEmptyString(params.chatGuid)) {
    return params.chatGuid.trim();
  }
  if (isNonEmptyString(params.chatIdentifier)) {
    return params.chatIdentifier.trim();
  }
  return undefined;
}

export function resolveIMessageInboundConversationId(params: {
  isGroup: boolean;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string | undefined {
  if (params.isGroup) {
    return resolveIMessageGroupAnchorId(params);
  }
  const sender = normalizeIMessageHandle(params.sender);
  return sender || undefined;
}
