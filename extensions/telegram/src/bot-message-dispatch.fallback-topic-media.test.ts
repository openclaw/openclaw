import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  setupDraftStreams,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

const statusTable = (rowHeaderColumnIndex?: number) => ({
  type: "table" as const,
  caption: "Status",
  headers: ["Key", "Value"],
  rows: [["Gateway", "running"]],
  ...(rowHeaderColumnIndex === undefined ? {} : { rowHeaderColumnIndex }),
});
const buttons = (label: string, url?: string) => ({
  type: "buttons" as const,
  buttons: [
    url ? { label, action: { type: "web-app" as const, url } } : { label, value: "x".repeat(65) },
  ],
});
async function dispatchPresentationFinal(payload: ReplyPayload, context = createContext()) {
  const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver(payload, { kind: "final" });
    return { queuedFinal: true };
  });
  await dispatchWithContext({
    context,
    streamMode: "partial",
    telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
  });
  expect(deliverReplies).not.toHaveBeenCalled();
  return answerDraftStream.update.mock.calls.at(-1)?.[0] as string;
}
function expectPresentation(
  text: string,
  labels: string[],
  contains = labels.map((x) => `- ${x}`),
) {
  expect(text).toContain("<table><caption>Status</caption>");
  for (const value of contains) {
    expect(text).toContain(value);
  }
  for (const label of labels) {
    expect(text.match(new RegExp(label, "g"))).toHaveLength(1);
  }
  expect(text).not.toBe("Gateway status as plain text");
}
function createMessageToolOnlyGroupContext(): TelegramMessageContext {
  const chat = { id: -1001234, type: "supergroup" };
  return createContext({
    chatId: chat.id,
    isGroup: true,
    ctxPayload: {
      SessionKey: "agent:test:telegram:group:-1001234",
      ChatType: "group",
    } as TelegramMessageContext["ctxPayload"],
    primaryCtx: { message: { chat } } as TelegramMessageContext["primaryCtx"],
    msg: { chat, message_id: 456 } as TelegramMessageContext["msg"],
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
  });
}
describeTelegramDispatch("dispatchTelegramMessage presentation and fallback policy", () => {
  it("respects richMessages=true on the finalized status preview", async () => {
    const finalUpdate = await dispatchPresentationFinal({
      text: "Gateway status as plain text",
      presentationTextMode: "fallback",
      presentation: { blocks: [statusTable(0)] },
    });
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("<td>running</td>");
  });
  it("keeps dropped labels: unset mixed", async () => {
    const finalUpdate = await dispatchPresentationFinal({
      text: "Status summary\n\n- Legacy\n- Presentation",
      presentation: { blocks: [statusTable(), buttons("Presentation")] },
      interactive: { blocks: [buttons("Legacy")] },
    });
    expect(finalUpdate).toContain("Status summary");
    expectPresentation(finalUpdate, ["Presentation", "Legacy"]);
  });
  it("keeps dropped labels: group web-app control", async () => {
    const finalUpdate = await dispatchPresentationFinal(
      {
        text: "Gateway status as plain text",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [statusTable(0), buttons("Launch", "https://example.com/app")],
        },
      },
      createContext({
        chatId: -1001234,
        isGroup: true,
        msg: { chat: { id: -1001234, type: "supergroup" } } as TelegramMessageContext["msg"],
        threadSpec: { id: 777, scope: "forum" },
      }),
    );
    expectPresentation(finalUpdate, ["Launch"], ["Launch: https://example.com/app"]);
  });
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
