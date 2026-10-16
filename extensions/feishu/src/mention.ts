import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FeishuMessageEvent } from "./event-types.js";
import type { MentionTarget } from "./mention-target.types.js";
import { isFeishuGroupChatType } from "./types.js";

type FeishuMentionLike = {
  key?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
};

export type FeishuTextMention = {
  key: string;
  id: string | { open_id?: string };
  name: string;
};

export function normalizeMentions(
  text: string,
  mentions?: ReadonlyArray<FeishuTextMention>,
  botStripId?: string,
): string {
  if (!mentions || mentions.length === 0) {
    return text;
  }
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const replacements = new Map<string, string>();
  for (const mention of mentions) {
    // Events nest open_id; message get/list return the selected identifier directly.
    const mentionId = typeof mention.id === "string" ? mention.id : mention.id.open_id;
    const replacement =
      botStripId && mentionId === botStripId
        ? ""
        : mentionId
          ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
          : `@${mention.name}`;
    replacements.set(mention.key, replacement);
  }
  // Longest keys win; a single pass keeps placeholder-like display names literal.
  const keys = [...replacements.keys()].toSorted((a, b) => b.length - a.length).map(escapeRegExp);
  return text.replace(new RegExp(keys.join("|"), "g"), (key) => replacements.get(key)!).trim();
}

export function isFeishuBroadcastMention(mention: FeishuMentionLike): boolean {
  const normalizedKey = mention.key?.trim().toLowerCase();
  if (normalizedKey === "@all" || normalizedKey === "@_all") {
    return true;
  }

  const mentionIds = [mention.id?.open_id, mention.id?.user_id, mention.id?.union_id];
  return mentionIds.some((id) => id?.trim().toLowerCase() === "all");
}

export function extractMentionTargets(
  event: FeishuMessageEvent,
  botOpenId: string,
): MentionTarget[] {
  const mentions = event.message.mentions ?? [];

  return mentions
    .filter(
      (m) => !isFeishuBroadcastMention(m) && m.id.open_id !== botOpenId && Boolean(m.id.open_id),
    )
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
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return false;
  }

  const isDirectMessage = !isFeishuGroupChatType(event.message.chat_type);
  const userMentions = mentions.filter((m) => !isFeishuBroadcastMention(m));
  const hasOtherMention = userMentions.some((m) => m.id.open_id !== normalizedBotOpenId);

  return (
    hasOtherMention &&
    (isDirectMessage || userMentions.some((m) => m.id.open_id === normalizedBotOpenId))
  );
}

export function buildMentionedCardContent(targets: MentionTarget[], message: string): string {
  if (targets.length === 0) {
    return message;
  }

  const mentionParts = targets.map((target) => `<at id=${target.openId}></at>`);
  return `${mentionParts.join(" ")} ${message}`;
}
