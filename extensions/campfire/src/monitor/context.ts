import type { CampfireWebhookPayload } from "../types.js";
import { isCampfireUrlInWorkspaceScope } from "../workspace-url.js";

function isAllowedReplyUrl(replyUrl: string, baseUrl: string): boolean {
  return isCampfireUrlInWorkspaceScope(replyUrl, baseUrl);
}

export function buildCampfireInboundContext(params: {
  payload: CampfireWebhookPayload;
  allowFrom?: string[];
  baseUrl: string;
}) {
  const { payload, allowFrom, baseUrl } = params;
  const senderId = String(payload.user.id);
  const senderName = payload.user.name;

  const normalizedAllowFrom = (allowFrom ?? []).map((entry) => entry.trim()).filter(Boolean);
  const senderAllowed =
    normalizedAllowFrom.length === 0 ||
    normalizedAllowFrom.includes("*") ||
    normalizedAllowFrom.includes(senderId);

  const replyUrlAllowed = isAllowedReplyUrl(payload.room.path, baseUrl);

  return {
    isAllowed: senderAllowed && replyUrlAllowed,
    sender: {
      id: senderId,
      name: senderName,
    },
    roomId: String(payload.room.id),
    roomName: payload.room.name,
    replyUrl: payload.room.path,
    messageId: String(payload.message.id),
    text: payload.message.body.plain,
    threadKey: `campfire:room:${payload.room.id}`,
  };
}
