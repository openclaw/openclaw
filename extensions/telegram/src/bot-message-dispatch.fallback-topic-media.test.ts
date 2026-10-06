import { expect, it } from "vitest";
import {
  createContext,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

function createMessageToolOnlyGroupContext(): TelegramMessageContext {
  return createContext({
    chatId: -1001234,
    isGroup: true,
    ctxPayload: {
      SessionKey: "agent:test:telegram:group:-1001234",
      ChatType: "group",
    } as TelegramMessageContext["ctxPayload"],
    primaryCtx: {
      message: { chat: { id: -1001234, type: "supergroup" } },
    } as TelegramMessageContext["primaryCtx"],
    msg: {
      chat: { id: -1001234, type: "supergroup" },
      message_id: 456,
    } as TelegramMessageContext["msg"],
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
  });
}

describeTelegramDispatch("dispatchTelegramMessage fallback send policy", () => {
  it("honors send-policy denial when final delivery fails", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({}, { kind: "final", reason: "empty" });
      await dispatcherOptions.onError?.(new Error("Final delivery failed"), { kind: "final" });
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sendPolicyDenied: true,
      };
    });

    await dispatchWithContext({
      cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
      context: createMessageToolOnlyGroupContext(),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });
});
