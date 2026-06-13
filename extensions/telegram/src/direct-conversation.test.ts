import { describe, expect, it } from "vitest";
import { parseTelegramDirectConversation } from "./direct-conversation.js";

describe("parseTelegramDirectConversation", () => {
  it("parses a bare positive peer id into its canonical form", () => {
    expect(
      parseTelegramDirectConversation({
        conversationId: "8517390162",
      }),
    ).toEqual({
      userId: "8517390162",
      canonicalConversationId: "8517390162",
    });
  });

  it("normalizes an explicit direct:<userId> config form", () => {
    expect(
      parseTelegramDirectConversation({
        conversationId: "direct:8517390162",
      }),
    ).toEqual({
      userId: "8517390162",
      canonicalConversationId: "8517390162",
    });
  });

  it("returns null for a negative (group/channel) chat id", () => {
    expect(
      parseTelegramDirectConversation({
        conversationId: "-1001234567890",
      }),
    ).toBeNull();
  });

  it("returns null for a topic conversation id", () => {
    expect(
      parseTelegramDirectConversation({
        conversationId: "-1001234567890:topic:42",
      }),
    ).toBeNull();
  });

  it("returns null for a non-numeric peer id", () => {
    expect(
      parseTelegramDirectConversation({
        conversationId: "not-a-peer",
      }),
    ).toBeNull();
  });

  it("returns null for an empty id", () => {
    expect(parseTelegramDirectConversation({ conversationId: "  " })).toBeNull();
  });
});
