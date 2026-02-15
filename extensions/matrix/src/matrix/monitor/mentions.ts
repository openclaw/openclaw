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
  // See: https://spec.matrix.org/latest/client-server-api/#user-and-room-mentions
  let mentionedInFormattedBody = false;
  if (params.userId && params.content.formatted_body) {
    // Match patterns like: href="https://matrix.to/#/@user:server.com"
    // Also handle URL-encoded versions like: href="https://matrix.to/#/%40user%3Aserver.com"
    // Matrix clients typically URL-encode the user ID in href attributes
    const escapedUserId = params.userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const encodedUserId = encodeURIComponent(params.userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Try both raw and URL-encoded patterns
    const rawPattern = new RegExp(
      `href=["']https://matrix\\.to/#/${escapedUserId}["']`,
      'i'
    );
    const encodedPattern = new RegExp(
      `href=["']https://matrix\\.to/#/${encodedUserId}["']`,
      'i'
    );
    
    mentionedInFormattedBody = 
      rawPattern.test(params.content.formatted_body) ||
      encodedPattern.test(params.content.formatted_body);
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
