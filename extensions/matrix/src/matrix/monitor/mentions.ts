import { getMatrixRuntime } from "../../runtime.js";

// Type for room message content with mentions
type MessageContentWithMentions = {
  msgtype: string;
  body: string;
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
  const wasMentioned =
    Boolean(mentions?.room) ||
    (params.userId ? mentionedUsers.has(params.userId) : false) ||
    getMatrixRuntime().channel.mentions.matchesMentionPatterns(
      params.text ?? "",
      params.mentionRegexes,
    );
  return { wasMentioned, hasExplicitMention: Boolean(mentions) };
}
