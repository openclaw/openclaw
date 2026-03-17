import { describe, expect, it } from "vitest";
import { DEFAULT_EMOJIS } from "../../../src/channels/status-reactions.js";
import {
  buildTelegramStatusReactionVariants,
  extractTelegramAllowedEmojiReactions,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis
} from "./status-reaction-variants.js";
describe("resolveTelegramStatusReactionEmojis", () => {
  it("falls back to Telegram-safe defaults for empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "\u{1F440}",
      overrides: {
        thinking: "   ",
        done: "\n"
      }
    });
    expect(result.queued).toBe("\u{1F440}");
    expect(result.thinking).toBe(DEFAULT_EMOJIS.thinking);
    expect(result.done).toBe(DEFAULT_EMOJIS.done);
  });
  it("preserves explicit non-empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "\u{1F440}",
      overrides: {
        thinking: "\u{1FAE1}",
        done: "\u{1F389}"
      }
    });
    expect(result.thinking).toBe("\u{1FAE1}");
    expect(result.done).toBe("\u{1F389}");
  });
});
describe("buildTelegramStatusReactionVariants", () => {
  it("puts requested emoji first and appends Telegram fallbacks", () => {
    const variants = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "\u{1F6E0}\uFE0F"
    });
    expect(variants.get("\u{1F6E0}\uFE0F")).toEqual(["\u{1F6E0}\uFE0F", "\u{1F468}\u200D\u{1F4BB}", "\u{1F525}", "\u26A1"]);
  });
});
describe("isTelegramSupportedReactionEmoji", () => {
  it("accepts Telegram-supported reaction emojis", () => {
    expect(isTelegramSupportedReactionEmoji("\u{1F440}")).toBe(true);
    expect(isTelegramSupportedReactionEmoji("\u{1F468}\u200D\u{1F4BB}")).toBe(true);
  });
  it("rejects unsupported emojis", () => {
    expect(isTelegramSupportedReactionEmoji("\u{1FAE0}")).toBe(false);
  });
});
describe("extractTelegramAllowedEmojiReactions", () => {
  it("returns undefined when chat does not include available_reactions", () => {
    const result = extractTelegramAllowedEmojiReactions({ id: 1 });
    expect(result).toBeUndefined();
  });
  it("returns null when available_reactions is omitted/null", () => {
    const result = extractTelegramAllowedEmojiReactions({ available_reactions: null });
    expect(result).toBeNull();
  });
  it("extracts emoji reactions only", () => {
    const result = extractTelegramAllowedEmojiReactions({
      available_reactions: [
        { type: "emoji", emoji: "\u{1F44D}" },
        { type: "custom_emoji", custom_emoji_id: "abc" },
        { type: "emoji", emoji: "\u{1F525}" }
      ]
    });
    expect(result ? Array.from(result).toSorted() : null).toEqual(["\u{1F44D}", "\u{1F525}"]);
  });
});
describe("resolveTelegramAllowedEmojiReactions", () => {
  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat = async () => ({
      available_reactions: [{ type: "emoji", emoji: "\u{1F44D}" }]
    });
    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 },
      chatId: 1,
      getChat
    });
    expect(result ? Array.from(result) : null).toEqual(["\u{1F44D}"]);
  });
  it("falls back to unrestricted reactions when getChat lookup fails", async () => {
    const getChat = async () => {
      throw new Error("lookup failed");
    };
    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 },
      chatId: 1,
      getChat
    });
    expect(result).toBeNull();
  });
});
describe("resolveTelegramReactionVariant", () => {
  it("returns requested emoji when already Telegram-supported", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "\u{1F468}\u200D\u{1F4BB}"
    });
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "\u{1F468}\u200D\u{1F4BB}",
      variantsByRequestedEmoji: variantsByEmoji
    });
    expect(result).toBe("\u{1F468}\u200D\u{1F4BB}");
  });
  it("returns first Telegram-supported fallback for unsupported requested emoji", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "\u{1F6E0}\uFE0F"
    });
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "\u{1F6E0}\uFE0F",
      variantsByRequestedEmoji: variantsByEmoji
    });
    expect(result).toBe("\u{1F468}\u200D\u{1F4BB}");
  });
  it("uses generic Telegram fallbacks for unknown emojis", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "\u{1FAE0}",
      variantsByRequestedEmoji: /* @__PURE__ */ new Map()
    });
    expect(result).toBe("\u{1F44D}");
  });
  it("respects chat allowed reactions", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "\u{1F468}\u200D\u{1F4BB}"
    });
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "\u{1F468}\u200D\u{1F4BB}",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: /* @__PURE__ */ new Set(["\u{1F44D}"])
    });
    expect(result).toBe("\u{1F44D}");
  });
  it("returns undefined when no candidate is chat-allowed", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "\u{1F468}\u200D\u{1F4BB}"
    });
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "\u{1F468}\u200D\u{1F4BB}",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: /* @__PURE__ */ new Set(["\u{1F389}"])
    });
    expect(result).toBeUndefined();
  });
  it("returns undefined for empty requested emoji", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "   ",
      variantsByRequestedEmoji: /* @__PURE__ */ new Map()
    });
    expect(result).toBeUndefined();
  });
});
