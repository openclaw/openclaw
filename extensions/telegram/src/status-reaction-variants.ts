import type { ReactionTypeCustomEmoji, ReactionTypeEmoji } from "grammy/types";
import { DEFAULT_EMOJIS, type StatusReactionEmojis } from "openclaw/plugin-sdk/channel-feedback";
import {
  normalizeOptionalString,
  normalizeUniqueStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";

type StatusReactionEmojiKey = keyof Required<StatusReactionEmojis>;
export type TelegramReactionEmoji = ReactionTypeEmoji["emoji"];
type TelegramAllowedReaction = ReactionTypeEmoji | ReactionTypeCustomEmoji;

const TELEGRAM_GENERIC_REACTION_FALLBACKS = ["👍", "👀", "🔥"] as const;

export const TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST = [
  "❤",
  "👍",
  "👎",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const satisfies readonly TelegramReactionEmoji[];

const TELEGRAM_SUPPORTED_REACTION_EMOJIS = new Map<string, TelegramReactionEmoji>(
  TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST.map((emoji) => [emoji, emoji]),
);

const TELEGRAM_STATUS_REACTION_VARIANTS: Record<StatusReactionEmojiKey, string[]> = {
  queued: ["👀", "👍", "🔥"],
  thinking: ["🤔", "🤓", "👀"],
  tool: ["🔥", "⚡", "👍"],
  coding: ["👨‍💻", "🔥", "⚡"],
  web: ["⚡", "🔥", "👍"],
  deploy: ["🔥", "⚡", "👍"],
  build: ["🔥", "👨‍💻", "⚡"],
  concierge: ["👀", "🔥", "⚡"],
  done: ["👍", "🎉", "💯"],
  error: ["😱", "😨", "🤯"],
  stallSoft: ["🥱", "😴", "🤔"],
  stallHard: ["😨", "😱", "⚡"],
  compacting: ["✍", "🤔", "🤯"],
};

const STATUS_REACTION_EMOJI_KEYS: StatusReactionEmojiKey[] = [
  "queued",
  "thinking",
  "tool",
  "coding",
  "web",
  "deploy",
  "build",
  "concierge",
  "done",
  "error",
  "stallSoft",
  "stallHard",
  "compacting",
];

export function resolveTelegramStatusReactionEmojis(params: {
  initialEmoji: string;
  overrides?: StatusReactionEmojis;
}): Required<StatusReactionEmojis> {
  const { overrides } = params;
  const queuedFallback = normalizeOptionalString(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
  const emojis = { ...DEFAULT_EMOJIS, queued: queuedFallback };
  for (const key of STATUS_REACTION_EMOJI_KEYS) {
    emojis[key] = normalizeOptionalString(overrides?.[key]) ?? emojis[key];
  }
  return emojis;
}

export function buildTelegramStatusReactionVariants(
  emojis: Required<StatusReactionEmojis>,
): Map<string, string[]> {
  const variantsByRequested = new Map<string, string[]>();
  for (const key of STATUS_REACTION_EMOJI_KEYS) {
    const requested = normalizeOptionalString(emojis[key]);
    if (!requested) {
      continue;
    }
    const candidates = normalizeUniqueStringEntries([
      requested,
      ...TELEGRAM_STATUS_REACTION_VARIANTS[key],
    ]);
    variantsByRequested.set(requested, candidates);
  }
  return variantsByRequested;
}

export function resolveTelegramReactionEmoji(emoji: string): TelegramReactionEmoji | undefined {
  // Telegram omits presentation selectors from reaction emoji but preserves joiner sequences.
  return TELEGRAM_SUPPORTED_REACTION_EMOJIS.get(emoji.trim().replace(/[\uFE0E\uFE0F]/gu, ""));
}

function extractTelegramAllowedReactions(
  chat: TelegramChatDetails | null | undefined,
): TelegramAllowedReaction[] | null | undefined {
  if (!chat) {
    return undefined;
  }
  const availableReactions = chat.available_reactions;
  if (availableReactions === undefined) {
    return undefined;
  }
  if (availableReactions == null) {
    // Explicitly omitted/null => all emoji reactions are allowed in this chat.
    return null;
  }
  if (!Array.isArray(availableReactions)) {
    return [];
  }

  const allowed: TelegramAllowedReaction[] = [];
  const identifiers = new Set<string>();
  for (const reaction of availableReactions) {
    if (reaction.type === "custom_emoji") {
      const identifier = normalizeOptionalString(reaction.custom_emoji_id);
      if (identifier && !identifiers.has(`custom:${identifier}`)) {
        identifiers.add(`custom:${identifier}`);
        allowed.push({ type: "custom_emoji", custom_emoji_id: identifier });
      }
      continue;
    }
    if (reaction.type !== "emoji") {
      continue;
    }
    const emoji = resolveTelegramReactionEmoji(reaction.emoji);
    if (emoji && !identifiers.has(`emoji:${emoji}`)) {
      identifiers.add(`emoji:${emoji}`);
      allowed.push({ type: "emoji", emoji });
    }
  }
  return allowed;
}

export async function resolveTelegramAllowedReactions(params: {
  chat: TelegramChatDetails | null | undefined;
  chatId: string | number;
  getChat?: TelegramGetChat;
}): Promise<TelegramAllowedReaction[] | null> {
  const fromMessage = extractTelegramAllowedReactions(params.chat);
  if (fromMessage !== undefined) {
    return fromMessage;
  }

  if (params.getChat) {
    const fromLookup = extractTelegramAllowedReactions(await params.getChat(params.chatId));
    if (fromLookup !== undefined) {
      return fromLookup;
    }
  }

  // If unavailable, assume no explicit restriction.
  return null;
}

export function resolveTelegramReactionVariant(params: {
  requestedEmoji: string;
  variantsByRequestedEmoji: Map<string, string[]>;
  allowedEmojiReactions?: Set<TelegramReactionEmoji> | null;
}): TelegramReactionEmoji | undefined {
  const requestedEmoji = normalizeOptionalString(params.requestedEmoji);
  if (!requestedEmoji) {
    return undefined;
  }

  const configuredVariants = params.variantsByRequestedEmoji.get(requestedEmoji) ?? [
    requestedEmoji,
  ];
  const variants = normalizeUniqueStringEntries([
    ...configuredVariants,
    ...TELEGRAM_GENERIC_REACTION_FALLBACKS,
  ]);

  for (const candidate of variants) {
    const emoji = resolveTelegramReactionEmoji(candidate);
    if (!emoji) {
      continue;
    }
    if (params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(emoji)) {
      return emoji;
    }
  }

  return undefined;
}
