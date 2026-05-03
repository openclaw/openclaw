import { describe, expect, it } from "vitest";
import {
  buildTelegramReactionSystemEventText,
  collectAddedTelegramReactions,
  normalizeTelegramReactionKey,
  resolveTelegramReactionSemantic,
} from "./reaction-events.js";

describe("telegram reaction events", () => {
  it("normalizes shorthand emoji keys and explicit custom emoji keys", () => {
    expect(normalizeTelegramReactionKey("👍")).toBe("emoji:👍");
    expect(normalizeTelegramReactionKey("👨‍💻")).toBe("emoji:👨‍💻");
    expect(normalizeTelegramReactionKey(" emoji:✅ ")).toBe("emoji:✅");
    expect(normalizeTelegramReactionKey("custom_emoji:1234567890123456789")).toBe(
      "custom_emoji:1234567890123456789",
    );
    expect(normalizeTelegramReactionKey("badprefix:value")).toBeNull();
    expect(normalizeTelegramReactionKey("emoji:thumbsup")).toBeNull();
    expect(normalizeTelegramReactionKey("custom_emoji:abc")).toBeNull();
    expect(normalizeTelegramReactionKey("thumbsup")).toBeNull();
  });

  it("collects newly added emoji and custom emoji reactions", () => {
    expect(
      collectAddedTelegramReactions({
        oldReactions: [
          { type: "emoji", emoji: "👍" },
          { type: "custom_emoji", custom_emoji_id: "111" },
        ],
        newReactions: [
          { type: "emoji", emoji: "👍" },
          { type: "emoji", emoji: "🔥" },
          { type: "custom_emoji", custom_emoji_id: "111" },
          { type: "custom_emoji", custom_emoji_id: "222" },
        ],
      }),
    ).toEqual([
      {
        key: "emoji:🔥",
        label: "🔥",
        type: "emoji",
        emoji: "🔥",
      },
      {
        key: "custom_emoji:222",
        label: "custom_emoji:222",
        type: "custom_emoji",
        customEmojiId: "222",
      },
    ]);
  });

  it("resolves semantic mappings for emoji shorthand and custom emoji ids", () => {
    expect(
      resolveTelegramReactionSemantic({
        reaction: {
          key: "emoji:👍",
          label: "👍",
          type: "emoji",
          emoji: "👍",
        },
        semantics: {
          "👍": "acknowledged",
        },
      }),
    ).toEqual({
      action: "wake",
      meaning: "acknowledged",
    });

    expect(
      resolveTelegramReactionSemantic({
        reaction: {
          key: "custom_emoji:1234567890123456789",
          label: "custom_emoji:1234567890123456789",
          type: "custom_emoji",
          customEmojiId: "1234567890123456789",
        },
        semantics: {
          "custom_emoji:1234567890123456789": {
            meaning: "execute-approved-plan",
            instruction:
              "Treat this as operator approval to execute the previously proposed action set if policy allows.",
            action: "queue",
          },
        },
      }),
    ).toEqual({
      action: "queue",
      meaning: "execute-approved-plan",
      instruction:
        "Treat this as operator approval to execute the previously proposed action set if policy allows.",
    });
  });

  it("builds semantic reaction system events with normalized keys", () => {
    expect(
      buildTelegramReactionSystemEventText({
        reaction: {
          key: "custom_emoji:1234567890123456789",
          label: "custom_emoji:1234567890123456789",
          type: "custom_emoji",
          customEmojiId: "1234567890123456789",
        },
        actorLabel: "Ada (@ada_bot)",
        messageId: 42,
        semantic: {
          action: "wake",
          meaning: "execute-approved-plan",
          instruction:
            "Treat this as operator approval to execute the previously proposed action set if policy allows.",
        },
      }),
    ).toBe(
      "Telegram reaction trigger: execute-approved-plan by Ada (@ada_bot) on msg 42 (reaction_key=custom_emoji:1234567890123456789). Treat this as operator approval to execute the previously proposed action set if policy allows.",
    );
  });
});
