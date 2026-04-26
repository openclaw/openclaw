import { describe, expect, it } from "vitest";
import { toFeishuEmojiType, FeishuEmoji } from "./reactions.js";

describe("toFeishuEmojiType", () => {
  it("passes Feishu enum strings through unchanged", () => {
    for (const value of Object.values(FeishuEmoji)) {
      expect(toFeishuEmojiType(value)).toBe(value);
    }
  });

  it("converts raw Unicode emojis to Feishu enum values", () => {
    expect(toFeishuEmojiType("👍")).toBe("THUMBSUP");
    expect(toFeishuEmojiType("👎")).toBe("THUMBSDOWN");
    expect(toFeishuEmojiType("❤️")).toBe("HEART");
    expect(toFeishuEmojiType("😊")).toBe("SMILE");
    expect(toFeishuEmojiType("😁")).toBe("GRINNING");
    expect(toFeishuEmojiType("😂")).toBe("LAUGHING");
    expect(toFeishuEmojiType("😭")).toBe("CRY");
    expect(toFeishuEmojiType("😡")).toBe("ANGRY");
    expect(toFeishuEmojiType("😮")).toBe("SURPRISED");
    expect(toFeishuEmojiType("🤔")).toBe("THINKING");
    expect(toFeishuEmojiType("👏")).toBe("CLAP");
    expect(toFeishuEmojiType("🙏")).toBe("PRAY");
    expect(toFeishuEmojiType("🔥")).toBe("FIRE");
    expect(toFeishuEmojiType("🎉")).toBe("PARTY");
    expect(toFeishuEmojiType("✅")).toBe("CHECK");
    expect(toFeishuEmojiType("❌")).toBe("CROSS");
    expect(toFeishuEmojiType("❓")).toBe("QUESTION");
    expect(toFeishuEmojiType("❗")).toBe("EXCLAMATION");
  });

  it("maps all heart colour variants to HEART", () => {
    const hearts = ["❤️", "❤", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍"];
    for (const heart of hearts) {
      expect(toFeishuEmojiType(heart)).toBe("HEART");
    }
  });

  it("maps skin-tone thumb-up variants to THUMBSUP", () => {
    const variants = ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"];
    for (const variant of variants) {
      expect(toFeishuEmojiType(variant)).toBe("THUMBSUP");
    }
  });

  it("falls back to THUMBSUP for unrecognised input", () => {
    expect(toFeishuEmojiType("🚀")).toBe("THUMBSUP");
    expect(toFeishuEmojiType("")).toBe("THUMBSUP");
    expect(toFeishuEmojiType("random")).toBe("THUMBSUP");
  });
});