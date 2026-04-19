/**
 * Inbound processing — platform-specific mention extraction.
 *
 * Extracts @mentioned users (non-bot) from message entities.
 * Bot mention detection is handled by the framework's matchesMentionPatterns() API;
 * this module only extracts target user mentions (e.g. @SomeUser).
 */

import type { YuanbaoMsgBodyElement } from "../../types.js";

/** Mentioned user info in a message (non-bot) */
export interface MentionedUser {
  /** Raw text form (e.g. "@SomeUser") */
  raw: string;
  /** Platform user ID (if extractable from message entity) */
  platformId?: string;
  /** Display name */
  displayName?: string;
}

/** Bot identifiers for filtering bot mentions */
export interface BotIdentifiers {
  botId?: string;
  botUsername?: string;
}

/**
 * Extract target user mentions (non-bot) from yuanbao message body.
 *
 * Yuanbao uses TIMCustomElem + elem_type=1002 for @ mentions.
 * Parses these elements and returns mentioned users, excluding the bot itself.
 */
export function extractTargetMentions(
  msgBody: YuanbaoMsgBodyElement[] | undefined,
  botIdentifiers: BotIdentifiers,
): MentionedUser[] {
  if (!msgBody || !Array.isArray(msgBody)) {
    return [];
  }

  const mentionedUsers: MentionedUser[] = [];

  for (const elem of msgBody) {
    if (elem.msg_type !== "TIMCustomElem") {
      continue;
    }

    const rawData = elem.msg_content?.data;
    if (!rawData || typeof rawData !== "string") {
      continue;
    }

    try {
      const customContent = JSON.parse(rawData);
      if (customContent?.elem_type !== 1002) {
        continue;
      }

      const userId: string | undefined = customContent.user_id;
      const { text } = customContent;

      // Skip bot's own mention
      if (userId && botIdentifiers.botId && userId === botIdentifiers.botId) {
        continue;
      }

      if (userId || text) {
        mentionedUsers.push({
          raw: text ?? `@${userId}`,
          platformId: userId,
          displayName: text?.replace(/^@/, "") ?? userId,
        });
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  return mentionedUsers;
}

/**
 * Regex fallback: extract target user mentions from raw text.
 *
 * Used when the message entity is unavailable or incomplete.
 */
export function extractTargetMentionsFromText(
  messageText: string,
  botIdentifiers: BotIdentifiers,
): MentionedUser[] {
  const mentionedUsers: MentionedUser[] = [];
  const mentionRegex = /@(\S+)/g;
  let match;

  while ((match = mentionRegex.exec(messageText)) !== null) {
    const handle = match[1];

    // Skip bot mention
    if (
      botIdentifiers.botUsername &&
      handle.toLowerCase() === botIdentifiers.botUsername.toLowerCase()
    ) {
      continue;
    }
    if (botIdentifiers.botId && handle === botIdentifiers.botId) {
      continue;
    }

    mentionedUsers.push({
      raw: match[0],
      displayName: handle,
    });
  }

  return mentionedUsers;
}

/**
 * Detect implicit mention (replying to bot's message in group chat).
 *
 * In Yuanbao, replying to the bot's message in a group chat
 * is treated as an implicit mention of the bot.
 */
export function detectImplicitMention(
  replyToAuthorId: string | undefined,
  botId: string | undefined,
  isDirectMessage: boolean,
): boolean {
  if (isDirectMessage) {
    return false;
  }
  if (!replyToAuthorId || !botId) {
    return false;
  }
  return replyToAuthorId === botId;
}
