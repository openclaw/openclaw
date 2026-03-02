import { describe, expect, it } from "vitest";
import { telegramUserbotThreadingAdapter } from "./threading.js";

describe("telegramUserbotThreadingAdapter", () => {
  describe("resolveReplyToMode", () => {
    it("returns 'all' by default", () => {
      const mode = telegramUserbotThreadingAdapter.resolveReplyToMode!({
        cfg: {} as never,
      });
      expect(mode).toBe("all");
    });
  });

  describe("allowExplicitReplyTagsWhenOff", () => {
    it("is true", () => {
      expect(telegramUserbotThreadingAdapter.allowExplicitReplyTagsWhenOff).toBe(true);
    });
  });

  describe("buildToolContext", () => {
    const build = telegramUserbotThreadingAdapter.buildToolContext!;

    it("builds context with target chat ID", () => {
      const result = build({
        cfg: {} as never,
        context: {
          To: "12345",
          CurrentMessageId: 42,
        },
      });
      expect(result).toMatchObject({
        currentChannelId: "12345",
        currentMessageId: 42,
        replyToMode: "all",
      });
    });

    it("strips telegram-userbot prefix from target", () => {
      const result = build({
        cfg: {} as never,
        context: {
          To: "telegram-userbot:54321",
          CurrentMessageId: 10,
        },
      });
      expect(result?.currentChannelId).toBe("54321");
    });

    it("sets currentThreadTs from MessageThreadId for forum topics", () => {
      const result = build({
        cfg: {} as never,
        context: {
          To: "12345",
          CurrentMessageId: 50,
          MessageThreadId: 999,
        },
      });
      expect(result?.currentThreadTs).toBe("999");
    });

    it("omits currentThreadTs when no MessageThreadId", () => {
      const result = build({
        cfg: {} as never,
        context: {
          To: "12345",
          CurrentMessageId: 50,
        },
      });
      expect(result?.currentThreadTs).toBeUndefined();
    });

    it("passes hasRepliedRef through", () => {
      const ref = { value: false };
      const result = build({
        cfg: {} as never,
        context: { To: "12345" },
        hasRepliedRef: ref,
      });
      expect(result?.hasRepliedRef).toBe(ref);
    });

    it("handles empty target gracefully", () => {
      const result = build({
        cfg: {} as never,
        context: { To: "" },
      });
      expect(result?.currentChannelId).toBeUndefined();
    });

    it("handles missing target gracefully", () => {
      const result = build({
        cfg: {} as never,
        context: {},
      });
      expect(result?.currentChannelId).toBeUndefined();
    });
  });
});
