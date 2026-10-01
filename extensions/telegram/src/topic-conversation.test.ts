// Telegram tests cover topic conversation plugin behavior.
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

describe("Telegram inbound conversation plugin contract", () => {
  it("keeps topics in one chat distinct in the channel resolver", () => {
    const resolve = telegramPlugin.messaging?.resolveInboundConversation;
    expect(resolve).toBeTypeOf("function");
    expect(
      resolve?.({ to: "-1001", conversationId: "-1001", threadId: "42", isGroup: true }),
    ).toEqual({ conversationId: "-1001:topic:42", parentConversationId: "-1001" });
    expect(
      resolve?.({ to: "-1001", conversationId: "-1001", threadId: "43", isGroup: true }),
    ).toEqual({ conversationId: "-1001:topic:43", parentConversationId: "-1001" });
  });
});

describe("parseTelegramTopicConversation", () => {
  it("parses direct chatId:topic:topicId strings", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "-1001234567890:topic:42",
      }),
    ).toEqual({
      chatId: "-1001234567890",
      thread: { id: 42, scope: "forum" },
      canonicalConversationId: "-1001234567890:topic:42",
    });
  });

  it("parses a bare topic id against a group parentConversationId", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "42",
        parentConversationId: "-1001234567890",
      }),
    ).toEqual({
      chatId: "-1001234567890",
      thread: { id: 42, scope: "forum" },
      canonicalConversationId: "-1001234567890:topic:42",
    });
  });

  it("keeps direct-message and forum topics with the same numeric id distinct", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "-1001234567890:direct-topic:42",
      }),
    ).toEqual({
      chatId: "-1001234567890",
      thread: { id: 42, scope: "direct-messages" },
      canonicalConversationId: "-1001234567890:direct-topic:42",
    });
  });

  it("returns null when a DM binding carries the chat id in both fields", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "1234",
        parentConversationId: "1234",
      }),
    ).toBeNull();
  });

  it("returns null when neither shape matches", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "not-a-topic",
      }),
    ).toBeNull();
  });

  it("returns null for a bare topic id without a parentConversationId", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "42",
      }),
    ).toBeNull();
  });
});
