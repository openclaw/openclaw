import type { FeishuMessageEvent } from "./bot.js";

/**
 * Escape regex metacharacters so user-controlled mention fields are treated literally.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mention target user info
 */
export type MentionTarget = {
  openId: string;
  name: string;
  key: string; // Placeholder in original message, e.g. @_user_1
};

/**
 * Check if a mention likely refers to a bot rather than a real user.
 *
 * Feishu's open_id namespace is app-specific: bot A cannot recognize bot B's
 * open_id. However, bot/app mentions have an empty (or missing) `tenant_key`
 * because apps created on the open platform don't belong to any tenant.
 * Regular users always have a non-empty `tenant_key`.
 */
export function isLikelyBotMention(mention: { tenant_key?: string }): boolean {
  return !mention.tenant_key;
}

/**
 * Extract mention targets from message event (excluding the bot itself
 * and other bot mentions detected via empty tenant_key)
 */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId?: string,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];

  return mentions
    .filter((m) => {
      // Exclude the bot itself
      if (botOpenId && m.id.open_id === botOpenId) {
        return false;
      }
      // Exclude other bot mentions (empty tenant_key = bot/app, not a real user)
      if (isLikelyBotMention(m)) {
        return false;
      }
      // Must have open_id
      return !!m.id.open_id;
    })
    .map((m) => ({
      openId: m.id.open_id!,
      name: m.name,
      key: m.key,
    }));
}

/**
 * Check if message is a mention forward request
 * Rules:
 * - Group: message mentions bot + at least one other user
 * - DM: message mentions any user (no need to mention bot)
 */
export function isMentionForwardRequest(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }

  const isDirectMessage = event.message.chat_type !== "group";
  // "Other mention" = non-self, non-bot (i.e. a real user)
  const hasRealUserMention = mentions.some(
    (m) => m.id.open_id !== botOpenId && !isLikelyBotMention(m),
  );

  if (isDirectMessage) {
    // DM: trigger if any real user is mentioned
    return hasRealUserMention;
  } else {
    // Group: need to mention both bot and at least one real user
    const hasBotMention = mentions.some((m) => m.id.open_id === botOpenId);
    return hasBotMention && hasRealUserMention;
  }
}

/**
 * Extract message body from text (remove @ placeholders)
 */
export function extractMessageBody(text: string, allMentionKeys: string[]): string {
  let result = text;

  // Remove all @ placeholders
  for (const key of allMentionKeys) {
    result = result.replace(new RegExp(escapeRegExp(key), "g"), "");
  }

  return result.replace(/\s+/g, " ").trim();
}

/**
 * Format @mention for text message
 */
export function formatMentionForText(target: MentionTarget): string {
  return `<at user_id="${target.openId}">${target.name}</at>`;
}

/**
 * Format @everyone for text message
 */
export function formatMentionAllForText(): string {
  return `<at user_id="all">Everyone</at>`;
}

/**
 * Format @mention for card message (lark_md)
 */
export function formatMentionForCard(target: MentionTarget): string {
  return `<at id=${target.openId}></at>`;
}

/**
 * Format @everyone for card message
 */
export function formatMentionAllForCard(): string {
  return `<at id=all></at>`;
}

/**
 * Build complete message with @mentions (text format)
 */
export function buildMentionedMessage(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForText(t));
  return `${mentionParts.join(" ")} ${message}`;
}

/**
 * Build card content with @mentions (Markdown format)
 */
export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((t) => formatMentionForCard(t));
  return `${mentionParts.join(" ")} ${message}`;
}
