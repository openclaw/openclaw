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

  it.each(["forum", "dm"] as const)(
    "keeps %s topic thread ids in the conversation key",
    (scope) => {
      const topic100 = buildTelegramInboundDebounceConversationKey({
        chatId: 7,
        threadSpec: { id: 100, scope },
      });
      const topic200 = buildTelegramInboundDebounceConversationKey({
        chatId: 7,
        threadSpec: { id: 200, scope },
      });

      expect(topic100).toBe(scope === "dm" ? "7:dm-topic:100" : "7:topic:100");
      expect(topic200).toBe(scope === "dm" ? "7:dm-topic:200" : "7:topic:200");
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
    },
  );

  it.each(["none", "dm"] as const)("uses the chat id for unthreaded %s messages", (scope) => {
    expect(buildTelegramInboundDebounceConversationKey({ chatId: 7, threadSpec: { scope } })).toBe(
      "7",
    );
  });
});
