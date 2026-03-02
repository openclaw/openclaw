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

/**
 * Check if the formatted_body contains a matrix.to mention link for the given user ID.
 * Many Matrix clients (including Element) use HTML links in formatted_body instead of
 * or in addition to the m.mentions field.
 */
function checkFormattedBodyMention(formattedBody: string | undefined, userId: string): boolean {
  if (!formattedBody || !userId) {
    return false;
  }
  // Escape special regex characters in the user ID (e.g., @user:matrix.org)
  const escapedUserId = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match matrix.to links with the user ID, handling both URL-encoded and plain formats
  // Example: href="https://matrix.to/#/@user:matrix.org" or href="https://matrix.to/#/%40user%3Amatrix.org"
  const plainPattern = new RegExp(`href=["']https://matrix\\.to/#/${escapedUserId}["']`, "i");
  if (plainPattern.test(formattedBody)) {
    return true;
  }
  // Also check URL-encoded version (@ -> %40, : -> %3A)
  const encodedUserId = encodeURIComponent(userId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const encodedPattern = new RegExp(`href=["']https://matrix\\.to/#/${encodedUserId}["']`, "i");
  return encodedPattern.test(formattedBody);
}

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
  const mentionedInFormattedBody = params.userId
    ? checkFormattedBodyMention(params.content.formatted_body, params.userId)
    : false;

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
