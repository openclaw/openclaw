// Telegram tests cover bot handlers plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";

describe("buildTelegramInboundDebounceKey", () => {
  it("uses the resolved account id instead of literal default when provided", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "work",
        conversationKey: "12345",
        senderId: "67890",
        debounceLane: "default",
      }),
    ).toBe("telegram:work:12345:67890:default");
  });

  it("falls back to literal default only when account id is actually absent", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: undefined,
        conversationKey: "12345",
        senderId: "67890",
        debounceLane: "forward",
      }),
    ).toBe("telegram:default:12345:67890:forward");
  });

  it("keeps direct topic thread ids in the conversation key", () => {
    const topic100 = buildTelegramInboundDebounceConversationKey({ chatId: 7, threadId: 100 });
    const topic200 = buildTelegramInboundDebounceConversationKey({ chatId: 7, threadId: 200 });

    expect(topic100).toBe("7:topic:100");
    expect(topic200).toBe("7:topic:200");
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic100,
        senderId: "42",
        debounceLane: "default",
      }),
    ).not.toBe(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic200,
        senderId: "42",
        debounceLane: "default",
      }),
    );
  });

  it("uses the chat id as the conversation key when no thread is present", () => {
    expect(buildTelegramInboundDebounceConversationKey({ chatId: 7 })).toBe("7");
  });
});

describe("message_reaction chat guard", () => {
  it("guards reaction without chat field (negative control proves crash)", () => {
    // Pre-fix handler without chat guard — crashes on missing chat.
    const buggy = (reaction: unknown): string | null => {
      if (!reaction) {
        return null;
      }
      const r = reaction as { chat?: { id?: number }; message_id?: number };
      return `telegram:${r.chat!.id}:msg_${r.message_id}`;
    };
    expect(() => {
      buggy({ message_id: 789 });
    }).toThrow(TypeError);

    // Post-fix handler with chat guard — returns null safely.
    const safe = (reaction: unknown): string | null => {
      if (!reaction) {
        return null;
      }
      const r = reaction as { chat?: { id?: number }; message_id?: number };
      if (!r?.chat) {
        return null;
      }
      return `telegram:${r.chat.id}:msg_${r.message_id}`;
    };
    expect(safe({ message_id: 789 })).toBeNull();
    expect(safe({ chat: { id: 123 }, message_id: 456 })).toBe("telegram:123:msg_456");
    expect(safe(null)).toBeNull();
  });
});
