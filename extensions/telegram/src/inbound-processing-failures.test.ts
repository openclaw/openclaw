// Telegram tests cover the inbound processing failure registry.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTelegramInboundProcessingFailureForUpdate,
  hasTelegramInboundProcessingFailureForUpdate,
  recordTelegramInboundProcessingFailure,
  resetTelegramInboundProcessingFailuresForTests,
  takeTelegramInboundProcessingFailureForUpdate,
} from "./inbound-processing-failures.js";

function messageUpdate(params: { chatId: number; messageId: number }) {
  return {
    update_id: 1,
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "private" },
      text: "hi",
    },
  };
}

describe("telegram inbound processing failures", () => {
  beforeEach(() => {
    resetTelegramInboundProcessingFailuresForTests();
  });

  it("takes a recorded failure for the matching update once", () => {
    const error = new Error("turn failed");
    recordTelegramInboundProcessingFailure({
      accountId: "default",
      chatId: 7,
      messageId: 99,
      error,
    });
    const update = messageUpdate({ chatId: 7, messageId: 99 });
    expect(hasTelegramInboundProcessingFailureForUpdate({ accountId: "default", update })).toBe(
      true,
    );
    expect(
      takeTelegramInboundProcessingFailureForUpdate({ accountId: "default", update })?.error,
    ).toBe(error);
    expect(takeTelegramInboundProcessingFailureForUpdate({ accountId: "default", update })).toBe(
      undefined,
    );
  });

  it("scopes failures by account, chat, and message", () => {
    recordTelegramInboundProcessingFailure({
      accountId: "default",
      chatId: 7,
      messageId: 99,
      error: new Error("turn failed"),
    });
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "other",
        update: messageUpdate({ chatId: 7, messageId: 99 }),
      }),
    ).toBe(undefined);
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: messageUpdate({ chatId: 7, messageId: 100 }),
      }),
    ).toBe(undefined);
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: messageUpdate({ chatId: 8, messageId: 99 }),
      }),
    ).toBe(undefined);
  });

  it("treats a missing or undefined accountId as the default account", () => {
    recordTelegramInboundProcessingFailure({
      chatId: 7,
      messageId: 99,
      error: new Error("turn failed"),
    });
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: messageUpdate({ chatId: 7, messageId: 99 }),
      }),
    ).toBeDefined();
  });

  it("matches edited messages and channel posts", () => {
    recordTelegramInboundProcessingFailure({
      accountId: "default",
      chatId: 7,
      messageId: 99,
      error: new Error("turn failed"),
    });
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: {
          update_id: 2,
          edited_message: { message_id: 99, chat: { id: 7, type: "private" } },
        },
      }),
    ).toBeDefined();
  });

  it("ignores updates without a message envelope", () => {
    recordTelegramInboundProcessingFailure({
      accountId: "default",
      chatId: 7,
      messageId: 99,
      error: new Error("turn failed"),
    });
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: { update_id: 3, callback_query: { id: "cb" } },
      }),
    ).toBe(undefined);
    expect(
      takeTelegramInboundProcessingFailureForUpdate({ accountId: "default", update: null }),
    ).toBe(undefined);
  });

  it("clears stale records for an update before a fresh attempt", () => {
    recordTelegramInboundProcessingFailure({
      accountId: "default",
      chatId: 7,
      messageId: 99,
      error: new Error("previous attempt failed"),
    });
    const update = messageUpdate({ chatId: 7, messageId: 99 });
    clearTelegramInboundProcessingFailureForUpdate({ accountId: "default", update });
    expect(hasTelegramInboundProcessingFailureForUpdate({ accountId: "default", update })).toBe(
      false,
    );
  });

  it("bounds the registry so untaken records cannot grow unbounded", () => {
    for (let i = 0; i < 400; i += 1) {
      recordTelegramInboundProcessingFailure({
        accountId: "default",
        chatId: 7,
        messageId: i,
        error: new Error(`failure ${i}`),
      });
    }
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: messageUpdate({ chatId: 7, messageId: 0 }),
      }),
    ).toBe(undefined);
    expect(
      takeTelegramInboundProcessingFailureForUpdate({
        accountId: "default",
        update: messageUpdate({ chatId: 7, messageId: 399 }),
      }),
    ).toBeDefined();
  });
});
