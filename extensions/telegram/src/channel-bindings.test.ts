import { describe, expect, it } from "vitest";
import {
  matchTelegramAcpConversation,
  normalizeTelegramAcpConversationId,
  resolveTelegramCommandConversation,
} from "./channel-bindings.js";

describe("normalizeTelegramAcpConversationId", () => {
  it("accepts group topics and rejects non-group conversations", () => {
    expect(normalizeTelegramAcpConversationId("-1001:topic:77")).toEqual({
      conversationId: "-1001:topic:77",
      parentConversationId: "-1001",
    });
    expect(normalizeTelegramAcpConversationId("12345")).toBeNull();
  });
});

describe("matchTelegramAcpConversation", () => {
  it("matches canonical topic conversations through parent fallback input", () => {
    expect(
      matchTelegramAcpConversation({
        bindingConversationId: "-1001:topic:77",
        conversationId: "77",
        parentConversationId: "-1001",
      }),
    ).toEqual({
      conversationId: "-1001:topic:77",
      parentConversationId: "-1001",
      matchPriority: 2,
    });
  });
});

describe("resolveTelegramCommandConversation", () => {
  it("preserves topic and direct command conversation routing", () => {
    expect(
      resolveTelegramCommandConversation({
        threadId: "77",
        originatingTo: "-1001",
      }),
    ).toEqual({
      conversationId: "-1001:topic:77",
      parentConversationId: "-1001",
    });

    expect(
      resolveTelegramCommandConversation({
        originatingTo: "12345",
      }),
    ).toEqual({
      conversationId: "12345",
      parentConversationId: "12345",
    });

    expect(
      resolveTelegramCommandConversation({
        originatingTo: "-1001",
      }),
    ).toBeNull();
  });
});
