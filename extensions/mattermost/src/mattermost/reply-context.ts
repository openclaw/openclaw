import type { MattermostPost, MattermostUser } from "./client.js";

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function resolveMattermostReplyContext(params: {
  effectiveReplyToId?: string;
  currentPostId?: string;
  resolvePostInfo: (postId: string) => Promise<MattermostPost | null>;
  resolveUserInfo: (userId: string) => Promise<MattermostUser | null>;
  botUserId: string;
  botUsername?: string;
  logVerboseMessage: (message: string) => void;
}): Promise<{ replyToBody?: string; replyToSender?: string }> {
  const effectiveReplyToId = normalizeOptionalString(params.effectiveReplyToId);
  const currentPostId = normalizeOptionalString(params.currentPostId);
  if (!effectiveReplyToId || effectiveReplyToId === currentPostId) {
    return {};
  }

  const replyPost = await params.resolvePostInfo(effectiveReplyToId);
  if (!replyPost) {
    params.logVerboseMessage(
      `mattermost: reply target lookup failed or returned no post post=${effectiveReplyToId}`,
    );
    return {};
  }

  const replyToBody = normalizeOptionalString(replyPost.message);
  let replyToSender: string | undefined;
  const replySenderId = normalizeOptionalString(replyPost.user_id);
  if (replySenderId) {
    if (replySenderId === params.botUserId && params.botUsername) {
      replyToSender = `@${params.botUsername}`;
    } else {
      const replyUser = await params.resolveUserInfo(replySenderId);
      const replyUsername = normalizeOptionalString(replyUser?.username);
      replyToSender = replyUsername ? `@${replyUsername}` : replySenderId;
    }
  }

  if (!replyToBody && !replyToSender) {
    params.logVerboseMessage(
      `mattermost: reply target resolved without visible context post=${effectiveReplyToId}`,
    );
  } else {
    params.logVerboseMessage(
      `mattermost: hydrated reply context post=${effectiveReplyToId} hasBody=${replyToBody ? "yes" : "no"} hasSender=${replyToSender ? "yes" : "no"}`,
    );
  }

  return { replyToBody, replyToSender };
}
