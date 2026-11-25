import { expect, it } from "vitest";
import { createTelegramNativeMessageLedger } from "./native-message-ledger.js";
import type { TelegramUserbotUpdate } from "./userbot-driver.runtime.js";

const chatId = -100123;

function message(messageId: number, text: string, replyToMessageId?: number) {
  return {
    kind: "message",
    chatId,
    messageId,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    senderId: 200,
    timestamp: 100_000,
    text,
    entities: [],
  } satisfies TelegramUserbotUpdate;
}

it("correlates an unthreaded fallback to its inbound by chat order", () => {
  const ledger = createTelegramNativeMessageLedger();
  const observe = (busId: string, update: TelegramUserbotUpdate) =>
    ledger.record(busId, { observer: 0, chatId, messageId: update.messageId }, update);
  ledger.record("first", { observer: 0, chatId, messageId: 10 });
  const firstFallback = message(11, "⚠️ first fallback");
  observe("bus-11", firstFallback);
  observe("bus-9", message(9, "older unthreaded send"));
  ledger.record("second", { observer: 0, chatId, messageId: 20 });
  const secondFallback = message(21, "⚠️ second fallback");
  const secondReply = message(22, "reply", 20);
  observe("bus-21", secondFallback);
  observe("bus-22", secondReply);
  ledger.record("other-observer", { observer: 1, chatId, messageId: 5 });
  expect(ledger.readUpdates("first")).toEqual([firstFallback]);
  expect(ledger.readUpdates("second")).toEqual([secondFallback, secondReply]);
  expect(ledger.readUpdates("other-observer")).toEqual([]);
});
