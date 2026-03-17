import {
  DEFAULT_EMOJIS
} from "../../../src/channels/status-reactions.js";
const TELEGRAM_GENERIC_REACTION_FALLBACKS = ["\u{1F44D}", "\u{1F440}", "\u{1F525}"];
const TELEGRAM_SUPPORTED_REACTION_EMOJIS = /* @__PURE__ */ new Set([
  "\u2764",
  "\u{1F44D}",
  "\u{1F44E}",
  "\u{1F525}",
  "\u{1F970}",
  "\u{1F44F}",
  "\u{1F601}",
  "\u{1F914}",
  "\u{1F92F}",
  "\u{1F631}",
  "\u{1F92C}",
  "\u{1F622}",
  "\u{1F389}",
  "\u{1F929}",
  "\u{1F92E}",
  "\u{1F4A9}",
  "\u{1F64F}",
  "\u{1F44C}",
  "\u{1F54A}",
  "\u{1F921}",
  "\u{1F971}",
  "\u{1F974}",
  "\u{1F60D}",
  "\u{1F433}",
  "\u2764\u200D\u{1F525}",
  "\u{1F31A}",
  "\u{1F32D}",
  "\u{1F4AF}",
  "\u{1F923}",
  "\u26A1",
  "\u{1F34C}",
  "\u{1F3C6}",
  "\u{1F494}",
  "\u{1F928}",
  "\u{1F610}",
  "\u{1F353}",
  "\u{1F37E}",
  "\u{1F48B}",
  "\u{1F595}",
  "\u{1F608}",
  "\u{1F634}",
  "\u{1F62D}",
  "\u{1F913}",
  "\u{1F47B}",
  "\u{1F468}\u200D\u{1F4BB}",
  "\u{1F440}",
  "\u{1F383}",
  "\u{1F648}",
  "\u{1F607}",
  "\u{1F628}",
  "\u{1F91D}",
  "\u270D",
  "\u{1F917}",
  "\u{1FAE1}",
  "\u{1F385}",
  "\u{1F384}",
  "\u2603",
  "\u{1F485}",
  "\u{1F92A}",
  "\u{1F5FF}",
  "\u{1F192}",
  "\u{1F498}",
  "\u{1F649}",
  "\u{1F984}",
  "\u{1F618}",
  "\u{1F48A}",
  "\u{1F64A}",
  "\u{1F60E}",
  "\u{1F47E}",
  "\u{1F937}\u200D\u2642",
  "\u{1F937}",
  "\u{1F937}\u200D\u2640",
  "\u{1F621}"
]);
const TELEGRAM_STATUS_REACTION_VARIANTS = {
  queued: ["\u{1F440}", "\u{1F44D}", "\u{1F525}"],
  thinking: ["\u{1F914}", "\u{1F913}", "\u{1F440}"],
  tool: ["\u{1F525}", "\u26A1", "\u{1F44D}"],
  coding: ["\u{1F468}\u200D\u{1F4BB}", "\u{1F525}", "\u26A1"],
  web: ["\u26A1", "\u{1F525}", "\u{1F44D}"],
  done: ["\u{1F44D}", "\u{1F389}", "\u{1F4AF}"],
  error: ["\u{1F631}", "\u{1F628}", "\u{1F92F}"],
  stallSoft: ["\u{1F971}", "\u{1F634}", "\u{1F914}"],
  stallHard: ["\u{1F628}", "\u{1F631}", "\u26A1"],
  compacting: ["\u270D", "\u{1F914}", "\u{1F92F}"]
};
const STATUS_REACTION_EMOJI_KEYS = [
  "queued",
  "thinking",
  "tool",
  "coding",
  "web",
  "done",
  "error",
  "stallSoft",
  "stallHard",
  "compacting"
];
function normalizeEmoji(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function toUniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
function resolveTelegramStatusReactionEmojis(params) {
  const { overrides } = params;
  const queuedFallback = normalizeEmoji(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
  return {
    queued: normalizeEmoji(overrides?.queued) ?? queuedFallback,
    thinking: normalizeEmoji(overrides?.thinking) ?? DEFAULT_EMOJIS.thinking,
    tool: normalizeEmoji(overrides?.tool) ?? DEFAULT_EMOJIS.tool,
    coding: normalizeEmoji(overrides?.coding) ?? DEFAULT_EMOJIS.coding,
    web: normalizeEmoji(overrides?.web) ?? DEFAULT_EMOJIS.web,
    done: normalizeEmoji(overrides?.done) ?? DEFAULT_EMOJIS.done,
    error: normalizeEmoji(overrides?.error) ?? DEFAULT_EMOJIS.error,
    stallSoft: normalizeEmoji(overrides?.stallSoft) ?? DEFAULT_EMOJIS.stallSoft,
    stallHard: normalizeEmoji(overrides?.stallHard) ?? DEFAULT_EMOJIS.stallHard,
    compacting: normalizeEmoji(overrides?.compacting) ?? DEFAULT_EMOJIS.compacting
  };
}
function buildTelegramStatusReactionVariants(emojis) {
  const variantsByRequested = /* @__PURE__ */ new Map();
  for (const key of STATUS_REACTION_EMOJI_KEYS) {
    const requested = normalizeEmoji(emojis[key]);
    if (!requested) {
      continue;
    }
    const fallbackVariants = TELEGRAM_STATUS_REACTION_VARIANTS[key] ?? [];
    const candidates = toUniqueNonEmpty([requested, ...fallbackVariants]);
    variantsByRequested.set(requested, candidates);
  }
  return variantsByRequested;
}
function isTelegramSupportedReactionEmoji(emoji) {
  return TELEGRAM_SUPPORTED_REACTION_EMOJIS.has(emoji);
}
function extractTelegramAllowedEmojiReactions(chat) {
  if (!chat || typeof chat !== "object") {
    return void 0;
  }
  if (!Object.prototype.hasOwnProperty.call(chat, "available_reactions")) {
    return void 0;
  }
  const availableReactions = chat.available_reactions;
  if (availableReactions == null) {
    return null;
  }
  if (!Array.isArray(availableReactions)) {
    return /* @__PURE__ */ new Set();
  }
  const allowed = /* @__PURE__ */ new Set();
  for (const reaction of availableReactions) {
    if (!reaction || typeof reaction !== "object") {
      continue;
    }
    const typedReaction = reaction;
    if (typedReaction.type !== "emoji" || typeof typedReaction.emoji !== "string") {
      continue;
    }
    const emoji = typedReaction.emoji.trim();
    if (emoji) {
      allowed.add(emoji);
    }
  }
  return allowed;
}
async function resolveTelegramAllowedEmojiReactions(params) {
  const fromMessage = extractTelegramAllowedEmojiReactions(params.chat);
  if (fromMessage !== void 0) {
    return fromMessage;
  }
  if (params.getChat) {
    try {
      const chatInfo = await params.getChat(params.chatId);
      const fromLookup = extractTelegramAllowedEmojiReactions(chatInfo);
      if (fromLookup !== void 0) {
        return fromLookup;
      }
    } catch {
      return null;
    }
  }
  return null;
}
function resolveTelegramReactionVariant(params) {
  const requestedEmoji = normalizeEmoji(params.requestedEmoji);
  if (!requestedEmoji) {
    return void 0;
  }
  const configuredVariants = params.variantsByRequestedEmoji.get(requestedEmoji) ?? [
    requestedEmoji
  ];
  const variants = toUniqueNonEmpty([
    ...configuredVariants,
    ...TELEGRAM_GENERIC_REACTION_FALLBACKS
  ]);
  for (const candidate of variants) {
    const isAllowedByChat = params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(candidate);
    if (isAllowedByChat && isTelegramSupportedReactionEmoji(candidate)) {
      return candidate;
    }
  }
  return void 0;
}
export {
  TELEGRAM_STATUS_REACTION_VARIANTS,
  buildTelegramStatusReactionVariants,
  extractTelegramAllowedEmojiReactions,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis
};
