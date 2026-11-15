import type { ReplyPayload } from "../auto-reply/reply-payload.js";

/**
 * Channel-facing reply payload emitted by embedded agents. Keep this type
 * small: channel adapters decide how to render text, media, and reply targets.
 */
export type BlockReplyPayload = Pick<
  ReplyPayload,
  | "text"
  | "mediaUrls"
  | "attachments"
  | "audioAsVoice"
  | "trustedLocalMedia"
  | "sensitiveMedia"
  | "isReasoning"
  | "isCommentary"
  | "replyToId"
  | "replyToTag"
  | "replyToCurrent"
  | "presentation"
  | "presentationTextMode"
  | "channelData"
>;
