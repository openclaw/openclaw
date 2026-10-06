import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export function resolveGoogleChatDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  spaceId: string;
  hasTypingMessage: boolean;
}) {
  if (params.infoKind !== "final" || params.hasTypingMessage) {
    return false;
  }
  const threadId = params.payload.replyToId?.trim() || undefined;
  if (!threadId) {
    return { to: params.spaceId, replyToId: null };
  }
  return {
    to: params.spaceId,
    replyToId: threadId,
    threadId,
  };
}
