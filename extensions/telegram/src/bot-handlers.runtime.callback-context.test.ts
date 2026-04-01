import { describe, expect, it } from "vitest";

import { resolveTelegramCallbackConversationContext } from "./bot-handlers.runtime.js";

describe("resolveTelegramCallbackConversationContext", () => {
  it("builds group topic callback context when a thread id is present", () => {
    const result = resolveTelegramCallbackConversationContext({
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId: 42,
    });

    expect(result).toEqual({
      threadId: 42,
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
    });
  });

  it("builds direct-message callback context without a parent conversation id", () => {
    const result = resolveTelegramCallbackConversationContext({
      chatId: 523353610,
      isGroup: false,
    });

    expect(result).toEqual({
      threadId: undefined,
      conversationId: "523353610",
      parentConversationId: undefined,
    });
  });
});
