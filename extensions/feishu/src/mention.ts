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

const AT_USER_ID_TAG_RE =
  /<at\s+user_id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>[\s\S]*?<\/at>/gi;
const AT_ID_TAG_RE = /<at\s+id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>/]+))\s*(?:\/>|>\s*<\/at>)/gi;

function pickMentionId(
  quotedDouble?: string,
  quotedSingle?: string,
  unquoted?: string,
): string | null {
  const value = (quotedDouble ?? quotedSingle ?? unquoted ?? "").trim();
  return value ? value : null;
}

export function normalizeMentionTagsForCard(content: string): string {
  if (!content.includes("<at")) {
    return content;
  }
  return content.replace(AT_USER_ID_TAG_RE, (full, quotedDouble, quotedSingle, unquoted) => {
    const id = pickMentionId(quotedDouble, quotedSingle, unquoted);
    if (!id) {
      return full;
    }
    return `<at id=${id}></at>`;
  });
}

export function normalizeMentionTagsForText(
  content: string,
  displayNameByOpenId?: Record<string, string>,
): string {
  if (!content.includes("<at")) {
    return content;
  }
  return content.replace(AT_ID_TAG_RE, (full, quotedDouble, quotedSingle, unquoted) => {
    const id = pickMentionId(quotedDouble, quotedSingle, unquoted);
    if (!id) {
      return full;
    }
    const displayName = displayNameByOpenId?.[id] ?? (id === "all" ? "Everyone" : id);
    return `<at user_id="${id}">${displayName}</at>`;
  });
}

/**
 * Build a Set of all known bot open IDs for filtering.
 */
function buildBotOpenIdSet(
  botOpenId?: string,
  allBotOpenIds?: Iterable<string | undefined>,
): Set<string> {
  const set = new Set<string>();
  if (botOpenId) set.add(botOpenId);
  if (allBotOpenIds) {
    for (const id of allBotOpenIds) {
      if (id) set.add(id);
    }
  }
  return set;
}

/**
 * Extract mention targets from message event (excluding all known bots)
 */
export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId?: string,
  allBotOpenIds?: Iterable<string | undefined>,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];
  const botIds = buildBotOpenIdSet(botOpenId, allBotOpenIds);

  return mentions
    .filter((m) => {
      if (!m.id.open_id) return false;
      // Exclude all known bots
      return !botIds.has(m.id.open_id);
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
export function isMentionForwardRequest(
  event: FeishuMessageEvent,
  botOpenId?: string,
  allBotOpenIds?: Iterable<string | undefined>,
): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) {
    return false;
  }

  const botIds = buildBotOpenIdSet(botOpenId, allBotOpenIds);
  const isDirectMessage = event.message.chat_type !== "group";
  // A "non-bot" mention is one whose open_id is not any known bot
  const hasHumanMention = mentions.some((m) => m.id.open_id && !botIds.has(m.id.open_id));

  if (isDirectMessage) {
    // DM: trigger if any non-bot user is mentioned
    return hasHumanMention;
  } else {
    // Group: need to mention the receiving bot and at least one human user
    const hasBotMention = botOpenId ? mentions.some((m) => m.id.open_id === botOpenId) : false;
    return hasBotMention && hasHumanMention;
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
