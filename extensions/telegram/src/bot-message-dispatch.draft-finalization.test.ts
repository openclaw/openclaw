import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

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
  richMessages?: boolean;
}) {
  const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver(params.payload, { kind: "final" });
    return { queuedFinal: true };
  });
  await dispatchWithContext({
    context: params.context ?? createContext(),
    streamMode: "partial",
    telegramCfg: { richMessages: params.richMessages ?? true, streaming: { mode: "partial" } },
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
  it.each([true, false])(
    "respects richMessages=%s on the finalized status preview",
    async (richMessages) => {
      const finalUpdate = await dispatchPresentationFinal({
        payload: {
          text: "Gateway status as plain text",
          presentationTextMode: "fallback",
          presentation: { blocks: [statusTable(0)] },
        },
        richMessages,
      });
      if (richMessages) {
        expect(finalUpdate).toContain("<table><caption>Status</caption>");
        expect(finalUpdate).toContain("<td>running</td>");
      } else {
        expect(finalUpdate).toBe("Gateway status as plain text");
      }
    },
  );
  it.each<{
    name: string;
    payload: ReplyPayload;
    labels: string[];
    authoredText?: string;
    context?: () => TelegramMessageContext;
    contains?: string[];
  }>([
    {
      name: "fallback presentation controls",
      payload: {
        text: "Gateway status as plain text",
        presentationTextMode: "fallback" as const,
        presentation: { blocks: [statusTable(0), droppedButtons("Copy manually", "Use link")] },
      },
      labels: ["Copy manually", "Use link"],
    },
    ...(["Status summary", "", "Status summary\n\n- Legacy\n- Presentation"] as const).map(
      (text) => ({
        name: `unset mixed ${text || "empty"}`,
        payload: {
          text,
          presentation: { blocks: [statusTable(), droppedButtons("Presentation")] },
          interactive: { blocks: [droppedButtons("Legacy")] },
        },
        labels: ["Presentation", "Legacy"],
        authoredText: text.split("\n\n")[0],
      }),
    ),
    ...([undefined, "fallback"] as const).map((presentationTextMode) => ({
      name: `legacy controls ${presentationTextMode ?? "unset"}`,
      payload: {
        text: "Gateway status as plain text",
        presentationTextMode,
        presentation: { blocks: [statusTable(0)] },
        interactive: { blocks: [droppedButtons("Copy manually", "Use link")] },
      },
      labels: ["Copy manually", "Use link"],
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
