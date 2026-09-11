// Googlechat plugin module implements monitor reply target behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

/**
 * Google Chat only accepts a thread resource (`spaces/x/threads/y`) as a reply
 * target. The automatic reply pipeline supplies the inbound *message* resource
 * (`spaces/x/messages/y`) instead, which delivery would read as an intentional
 * retarget and use to discard the typing placeholder. Reconcile that exact
 * source-message target back to the inbound thread before delivery, and leave
 * every other target untouched so explicit retargeting still works.
 */
export function normalizeGoogleChatReplyTarget(params: {
  payload: ReplyPayload;
  sourceMessageName?: string;
  replyThreadName?: string;
}): ReplyPayload {
  const sourceMessageName = params.sourceMessageName;
  if (!sourceMessageName || params.payload.replyToId !== sourceMessageName) {
    return params.payload;
  }
  return { ...params.payload, replyToId: params.replyThreadName };
}
