import type { CallbackQuery, Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { handleTelegramInteractiveCallback } from "./bot-handlers.callback-interactions.runtime.js";

vi.mock("./interactive-dispatch.js", () => ({
  dispatchTelegramPluginInteractiveHandler: vi.fn(async () => ({ handled: false })),
}));

describe("handleTelegramInteractiveCallback", () => {
  it("builds managed-select turns from callback sender and originating message chat", async () => {
    let syntheticMessage: Message | undefined;
    const callbackMessage = {
      message_id: 41,
      date: 1,
      chat: { id: -1001234, type: "supergroup", title: "Family" },
      from: { id: 99, is_bot: false, first_name: "Original author" },
    } as Message;
    const callback = {
      id: "callback-1",
      chat_instance: "instance-1",
      from: { id: 9, is_bot: false, first_name: "Verified actor" },
      message: callbackMessage,
      data: "OC_SELECT|choice",
    } as CallbackQuery;

    const handled = await handleTelegramInteractiveCallback({
      accountId: "default",
      callback,
      ctx: { me: { id: 1, is_bot: true, first_name: "Bot" }, getFile: vi.fn() } as never,
      callbackMessage,
      data: "OC_SELECT|choice",
      pluginCallbackData: "OC_SELECT|choice",
      callbackConversationId: "-1001234",
      senderId: "9",
      senderUsername: "",
      isGroup: true,
      isForum: false,
      storeAllowFrom: [],
      actions: {
        clearCallbackButtons: vi.fn(async () => undefined),
      } as never,
      messageRuntime: {
        buildSyntheticTextMessage: ({ base, from, text }) => ({ ...base, from, text }),
        buildSyntheticContext: (_ctx, message) => ({ message }),
        buildFailedProcessingResult: (error) => ({ kind: "failed-retryable", error }),
        processMessageWithReplyChain: vi.fn(async ({ msg }) => {
          syntheticMessage = msg;
          return { kind: "completed" };
        }),
      } as never,
      authorizeCallback: vi.fn(async () => true),
    });

    expect(handled).toBe(true);
    expect(syntheticMessage?.from?.id).toBe(9);
    expect(syntheticMessage?.chat.id).toBe(-1001234);
    expect(syntheticMessage?.chat.type).toBe("supergroup");
  });
});
