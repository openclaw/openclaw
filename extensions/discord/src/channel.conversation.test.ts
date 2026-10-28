// Discord tests cover channel.conversation plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordInboundConversation } from "./channel.conversation.js";

describe("Discord conversation identity", () => {
  it.each([undefined, "1510164477642014740"])(
    "normalizes a conversation target once with thread %s",
    (threadId) => {
      const target = "discord:channel:1510164477642014999";
      let targetTrims = 0;
      const trimSpy = vi.spyOn(String.prototype, "trim");
      let resolved;
      try {
        resolved = resolveDiscordInboundConversation({
          to: `  ${target}  `,
          threadId,
          isGroup: true,
        });
        targetTrims = trimSpy.mock.contexts.filter(
          (value) => value === target || value === `  ${target}  `,
        ).length;
      } finally {
        trimSpy.mockRestore();
      }
      expect(resolved).toEqual(
        threadId
          ? { conversationId: threadId, parentConversationId: "channel:1510164477642014999" }
          : { conversationId: "channel:1510164477642014999" },
      );
      expect(targetTrims).toBe(1);
    },
  );

  it("falls back to the current target when inbound thread parent ids are unavailable", () => {
    expect(
      resolveDiscordInboundConversation({
        from: "discord:user:570610468352294922",
        to: "channel:1510164477642014740",
        conversationId: "channel:1510164477642014740",
        threadId: "1510164477642014740",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014740",
    });
  });

  it("keeps top-level channel conversations prefixed", () => {
    expect(
      resolveDiscordInboundConversation({
        from: "discord:user:570610468352294922",
        to: "channel:1510164477642014740",
        conversationId: "channel:1510164477642014740",
        isGroup: true,
      }),
    ).toEqual({ conversationId: "channel:1510164477642014740" });
  });

  it("resolves the parent channel for inbound thread conversations", () => {
    const resolved = resolveDiscordInboundConversation({
      from: "discord:user:570610468352294922",
      to: "channel:1510164477642014740",
      conversationId: "channel:1510164477642014740",
      threadId: "1510164477642014740",
      threadParentId: "1510164477642014999",
      isGroup: true,
    });

    expect(resolved).toEqual({
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014999",
    });
  });
});
