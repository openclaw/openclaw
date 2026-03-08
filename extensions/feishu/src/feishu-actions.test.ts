import { describe, expect, it } from "vitest";
import { normalizeFeishuEmoji } from "./feishu-actions.js";

describe("feishu-actions", () => {
  describe("normalizeFeishuEmoji", () => {
    it("should pass through uppercase Feishu emoji types", () => {
      expect(normalizeFeishuEmoji("THUMBSUP")).toBe("THUMBSUP");
      expect(normalizeFeishuEmoji("HEART")).toBe("HEART");
      expect(normalizeFeishuEmoji("FIRE")).toBe("FIRE");
      expect(normalizeFeishuEmoji("THINKING")).toBe("THINKING");
    });

    it("should normalize lowercase to uppercase", () => {
      expect(normalizeFeishuEmoji("thumbsup")).toBe("THUMBSUP");
      expect(normalizeFeishuEmoji("heart")).toBe("HEART");
      expect(normalizeFeishuEmoji("fire")).toBe("FIRE");
    });

    it("should strip Slack-style colons", () => {
      expect(normalizeFeishuEmoji(":thumbsup:")).toBe("THUMBSUP");
      expect(normalizeFeishuEmoji(":heart:")).toBe("HEART");
      expect(normalizeFeishuEmoji(":fire:")).toBe("FIRE");
    });

    it("should map Unicode emoji to Feishu types", () => {
      expect(normalizeFeishuEmoji("👍")).toBe("THUMBSUP");
      expect(normalizeFeishuEmoji("👎")).toBe("THUMBSDOWN");
      expect(normalizeFeishuEmoji("❤️")).toBe("HEART");
      expect(normalizeFeishuEmoji("❤")).toBe("HEART");
      expect(normalizeFeishuEmoji("🔥")).toBe("FIRE");
      expect(normalizeFeishuEmoji("🎉")).toBe("PARTY");
      expect(normalizeFeishuEmoji("🤔")).toBe("THINKING");
      expect(normalizeFeishuEmoji("👏")).toBe("CLAP");
      expect(normalizeFeishuEmoji("🙏")).toBe("PRAY");
      expect(normalizeFeishuEmoji("✅")).toBe("CHECK");
      expect(normalizeFeishuEmoji("❌")).toBe("CROSS");
    });

    it("should default to THUMBSUP for empty input", () => {
      expect(normalizeFeishuEmoji("")).toBe("THUMBSUP");
    });

    it("should uppercase unknown emoji names", () => {
      expect(normalizeFeishuEmoji("custom_emoji")).toBe("CUSTOM_EMOJI");
      expect(normalizeFeishuEmoji("rocket")).toBe("ROCKET");
    });

    it("should handle whitespace", () => {
      expect(normalizeFeishuEmoji("  thumbsup  ")).toBe("THUMBSUP");
      expect(normalizeFeishuEmoji("  :heart:  ")).toBe("HEART");
    });
  });

  describe("feishuMessageActions structure", () => {
    it("should export the expected adapter shape", async () => {
      const mod = await import("./feishu-actions.js");
      expect(mod.feishuMessageActions).toBeDefined();
      expect(typeof mod.feishuMessageActions.listActions).toBe("function");
      expect(typeof mod.feishuMessageActions.handleAction).toBe("function");
    });
  });
});