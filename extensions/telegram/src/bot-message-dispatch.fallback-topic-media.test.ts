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
const droppedButtons = (...labels: string[]) => ({
  type: "buttons" as const,
  buttons: labels.map((label) => ({ label, value: "x".repeat(65) })),
});
async function dispatchPresentationFinal(params: {
  payload: ReplyPayload;
  context?: TelegramMessageContext;
}) {
  const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver(params.payload, { kind: "final" });
    return { queuedFinal: true };
  });
  await dispatchWithContext({
    context: params.context ?? createContext(),
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
describeTelegramDispatch("dispatchTelegramMessage draft-finalization", () => {
  it("respects richMessages=true on the finalized status preview", async () => {
    const finalUpdate = await dispatchPresentationFinal({
      payload: {
        text: "Gateway status as plain text",
        presentationTextMode: "fallback",
        presentation: { blocks: [statusTable(0)] },
      },
    });
    expect(finalUpdate).toContain("<table><caption>Status</caption>");
    expect(finalUpdate).toContain("<td>running</td>");
  });
  it.each<{
    name: string;
    payload: ReplyPayload;
    labels: string[];
    authoredText?: string;
    context?: () => TelegramMessageContext;
    contains?: string[];
  }>([
    ...(["Status summary\n\n- Legacy\n- Presentation"] as const).map((text) => ({
      name: `unset mixed ${text || "empty"}`,
      payload: {
        text,
        presentation: { blocks: [statusTable(), droppedButtons("Presentation")] },
        interactive: { blocks: [droppedButtons("Legacy")] },
      },
      labels: ["Presentation", "Legacy"],
      authoredText: text.split("\n\n")[0],
    })),
    {
      name: "group web-app control",
      payload: {
        text: "Gateway status as plain text",
        presentationTextMode: "fallback" as const,
        presentation: {
          blocks: [
            statusTable(0),
            {
              type: "buttons",
              buttons: [
                { label: "Launch", action: { type: "web-app", url: "https://example.com/app" } },
              ],
            },
          ],
        },
      },
      context: () =>
        createContext({
          chatId: -1001234,
          isGroup: true,
          msg: {
            chat: { id: -1001234, type: "supergroup" },
            message_id: 456,
            message_thread_id: 777,
          } as TelegramMessageContext["msg"],
          threadSpec: { id: 777, scope: "forum" },
        }),
      labels: ["Launch"],
      contains: ["Launch: https://example.com/app"],
    },
  ])(
    "keeps dropped labels: $name",
    async ({ payload, labels, authoredText, context, contains }) => {
      const finalUpdate = await dispatchPresentationFinal({ payload, context: context?.() });
      if (authoredText) {
        expect(finalUpdate).toContain(authoredText);
      }
      expectPresentation(finalUpdate, labels, contains);
    },
  );
});

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
