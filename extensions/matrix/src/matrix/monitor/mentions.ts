import { getMatrixRuntime } from "../../runtime.js";

// Type for room message content with mentions
type MessageContentWithMentions = {
  msgtype: string;
  body: string;
  formatted_body?: string;
  "m.mentions"?: {
    user_ids?: string[];
    room?: boolean;
  };
};

export function resolveMentions(params: {
  content: MessageContentWithMentions;
  userId?: string | null;
  text?: string;
  mentionRegexes: RegExp[];
}) {
  const mentions = params.content["m.mentions"];
  const mentionedUsers = Array.isArray(mentions?.user_ids)
    ? new Set(mentions.user_ids)
    : new Set<string>();

  // Check formatted_body for matrix.to mention links (legacy/alternative mention format)
  // Many Matrix clients use this format instead of or in addition to m.mentions
  let mentionedInFormattedBody = false;
  if (params.userId && params.content.formatted_body) {
    // Match patterns like: href="https://matrix.to/#/@user:server.com"
    const escapedUserId = params.userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matrixToPattern = new RegExp(
      `href=["']https://matrix\\.to/#/${escapedUserId}["']`,
      'i'
    );
    mentionedInFormattedBody = matrixToPattern.test(params.content.formatted_body);
  }

  const wasMentioned =
    Boolean(mentions?.room) ||
    (params.userId ? mentionedUsers.has(params.userId) : false) ||
    mentionedInFormattedBody ||
    getMatrixRuntime().channel.mentions.matchesMentionPatterns(
      params.text ?? "",
      params.mentionRegexes,
    );
  return { wasMentioned, hasExplicitMention: Boolean(mentions) };
}
