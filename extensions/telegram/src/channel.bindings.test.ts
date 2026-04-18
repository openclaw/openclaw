import { describe, expect, it } from "vitest";
import { telegramBindingsAdapter } from "./channel.js";

describe("telegramBindingsAdapter", () => {
  it("normalizes configured direct-chat ACP bindings", () => {
    const compiled = telegramBindingsAdapter.compileConfiguredBinding({
      conversationId: "123456789",
    });

    expect(compiled).toEqual({
      conversationId: "123456789",
      parentConversationId: "123456789",
    });
    expect(
      telegramBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "123456789",
        parentConversationId: "123456789",
      }),
    ).toEqual({
      conversationId: "123456789",
      parentConversationId: "123456789",
      matchPriority: 2,
    });
  });

  it("continues normalizing configured topic ACP bindings", () => {
    const compiled = telegramBindingsAdapter.compileConfiguredBinding({
      conversationId: "-1001234567890:topic:42",
    });

    expect(compiled).toEqual({
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
    });
    expect(
      telegramBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      }),
    ).toEqual({
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      matchPriority: 2,
    });
  });

  it("rejects bare negative chat ids so whole group chats still do not bind implicitly", () => {
    expect(
      telegramBindingsAdapter.compileConfiguredBinding({
        conversationId: "-1001234567890",
      }),
    ).toBeNull();
  });
});
