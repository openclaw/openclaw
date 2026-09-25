// Telegram tests cover inbound buffering identity.
import { describe, expect, it } from "vitest";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";

describe("buildTelegramInboundDebounceKey", () => {
  it("isolates accounts and senders while normalizing the absent account", () => {
    const conversationKey = "12345";
    const senderId = "67890";
    const defaultKey = buildTelegramInboundDebounceKey({ conversationKey, senderId });
    expect(
      buildTelegramInboundDebounceKey({ accountId: "default", conversationKey, senderId }),
    ).toBe(defaultKey);
    expect(
      buildTelegramInboundDebounceKey({ accountId: "work", conversationKey, senderId }),
    ).not.toBe(defaultKey);
    expect(buildTelegramInboundDebounceKey({ conversationKey, senderId: "67891" })).not.toBe(
      defaultKey,
    );
  });

  it("keeps scoped topic thread ids in the conversation key", () => {
    const topic100 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 100, scope: "forum" },
    });
    const topic200 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 200, scope: "forum" },
    });

    expect(topic100).toBe("7:topic:100");
    expect(topic200).toBe("7:topic:200");
    expect(
      buildTelegramInboundDebounceConversationKey({
        chatId: 7,
        threadSpec: { id: 100, scope: "direct-messages" },
      }),
    ).toBe("7:direct-topic:100");
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic100,
        senderId: "42",
      }),
    ).not.toBe(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: topic200,
        senderId: "42",
      }),
    );
  });

  it("uses the chat id as the conversation key when no thread is present", () => {
    expect(
      buildTelegramInboundDebounceConversationKey({ chatId: 7, threadSpec: { scope: "none" } }),
    ).toBe("7");
  });

  it("isolates private DM topics by thread id", () => {
    const dmTopic100 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 100, scope: "dm" },
    });
    const dmTopic200 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 200, scope: "dm" },
    });
    const dmNoThread = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { scope: "dm" },
    });
    const forumTopic100 = buildTelegramInboundDebounceConversationKey({
      chatId: 7,
      threadSpec: { id: 100, scope: "forum" },
    });

    // Distinct DM topics get distinct keys
    expect(dmTopic100).toBe("7:dm-topic:100");
    expect(dmTopic200).toBe("7:dm-topic:200");
    expect(dmTopic100).not.toBe(dmTopic200);

    // DM with no thread stays chat-scoped
    expect(dmNoThread).toBe("7");
    expect(dmTopic100).not.toBe(dmNoThread);

    // DM topic and forum topic with same id do not collide
    expect(dmTopic100).not.toBe(forumTopic100);

    // Full debounce keys differ across DM topics
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: dmTopic100,
        senderId: "42",
        debounceLane: "default",
      }),
    ).not.toBe(
      buildTelegramInboundDebounceKey({
        accountId: "default",
        conversationKey: dmTopic200,
        senderId: "42",
        debounceLane: "default",
      }),
    );
  });
});
