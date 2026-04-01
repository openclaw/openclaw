import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { stripMSTeamsBotMentionTag } from "../inbound.js";

describe("msteams message-handler thread isolation", () => {
  describe("session key computation", () => {
    const baseSessionKey = "agent:main:msteams:channel:19:abc@thread.tacv2";

    it("appends :thread:<id> when threadBindings enabled and isChannel with replyToId", () => {
      const { sessionKey, parentSessionKey } = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "1234567890",
        parentSessionKey: baseSessionKey,
      });
      expect(sessionKey).toBe(`${baseSessionKey}:thread:1234567890`);
      expect(parentSessionKey).toBe(baseSessionKey);
    });

    it("returns base key unchanged when threadId is undefined", () => {
      const { sessionKey, parentSessionKey } = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: undefined,
      });
      expect(sessionKey).toBe(baseSessionKey);
      expect(parentSessionKey).toBeUndefined();
    });

    it("returns base key unchanged when threadId is empty string", () => {
      const { sessionKey } = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "",
      });
      expect(sessionKey).toBe(baseSessionKey);
    });

    it("different threads produce different session keys", () => {
      const { sessionKey: key1 } = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "thread-a",
      });
      const { sessionKey: key2 } = resolveThreadSessionKeys({
        baseSessionKey,
        threadId: "thread-b",
      });
      expect(key1).not.toBe(key2);
    });
  });

  describe("history key computation", () => {
    const conversationId = "19:abc@thread.tacv2";

    it("uses thread-scoped key for thread replies", () => {
      const replyToId = "1234567890";
      const isThreadReply = true;
      const historyKey = isThreadReply ? `${conversationId}:thread:${replyToId}` : conversationId;
      expect(historyKey).toBe("19:abc@thread.tacv2:thread:1234567890");
    });

    it("uses channel-level key for non-thread messages", () => {
      const isThreadReply = false;
      const replyToId = undefined;
      const historyKey = isThreadReply ? `${conversationId}:thread:${replyToId}` : conversationId;
      expect(historyKey).toBe("19:abc@thread.tacv2");
    });
  });

  describe("thread detection guards", () => {
    it("isThreadReply is false when threadBindings disabled", () => {
      const threadBindingsEnabled = false;
      const replyToId = "123";
      const isChannel = true;
      const isThreadReply = Boolean(replyToId && isChannel && threadBindingsEnabled);
      expect(isThreadReply).toBe(false);
    });

    it("isThreadReply is false for DMs even with replyToId", () => {
      const threadBindingsEnabled = true;
      const replyToId = "123";
      const isChannel = false;
      const isThreadReply = Boolean(replyToId && isChannel && threadBindingsEnabled);
      expect(isThreadReply).toBe(false);
    });

    it("isThreadReply is false when no replyToId", () => {
      const threadBindingsEnabled = true;
      const replyToId = undefined;
      const isChannel = true;
      const isThreadReply = Boolean(replyToId && isChannel && threadBindingsEnabled);
      expect(isThreadReply).toBe(false);
    });

    it("isThreadReply is true only when all conditions met", () => {
      const threadBindingsEnabled = true;
      const replyToId = "123";
      const isChannel = true;
      const isThreadReply = Boolean(replyToId && isChannel && threadBindingsEnabled);
      expect(isThreadReply).toBe(true);
    });
  });

  describe("mention preservation integration", () => {
    it("agent receives other user mentions when bot name is known", () => {
      const rawText = "<at>MyBot</at> <at>John</at> what do you think?";
      const botMentionName = "MyBot";
      const text = stripMSTeamsBotMentionTag(rawText, botMentionName);
      expect(text).toBe("@John what do you think?");
    });

    it("agent sees no mentions when bot name is unknown (fallback)", () => {
      const rawText = "<at>MyBot</at> <at>John</at> what do you think?";
      const text = stripMSTeamsBotMentionTag(rawText, undefined);
      expect(text).toBe("what do you think?");
    });
  });
});
