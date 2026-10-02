import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage room-event failure policy", () => {
  it("does not send visible error fallbacks for room events", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("provider down"));

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "101",
          RawBody: "ambient failure",
          BodyForAgent: "ambient failure",
          CommandBody: "ambient failure",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 101,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey: "telegram:group:-100123",
        historyLimit: 10,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });
});
