import { Bot } from "grammy";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import {
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitToolStart,
} from "./bot-message-dispatch.test-harness.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import type { TelegramDraftStream } from "./draft-stream.js";

const question = {
  text: "Should this harmless check continue?",
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
};

describeTelegramDispatch("dispatchTelegramMessage native questions", () => {
  it.each(["progress", "partial"] as const)(
    "retains the accepted question when the %s stream retires its progress window",
    async (streamMode) => {
      vi.useFakeTimers();
      let draft: TelegramDraftStream | undefined;
      try {
        const actualDraft =
          await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof import("./send-edit.js")>("./send-edit.js");
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        deliverReplies.mockImplementation(actualDelivery.deliverReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        const visible = new Map<number, string>();
        let nextMessageId = 1001;
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const method = new URL(input instanceof Request ? input.url : String(input)).pathname
            .split("/")
            .at(-1);
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON Telegram request");
          }
          const payload = asNonArrayRecord(JSON.parse(init.body));
          const messageId =
            typeof payload.message_id === "number" ? payload.message_id : nextMessageId++;
          if (method === "deleteMessage") {
            visible.delete(messageId);
            return Response.json({ ok: true, result: true });
          }
          if (method !== "sendMessage" && method !== "editMessageText") {
            throw new Error(`Unexpected Telegram method: ${method}`);
          }
          if (typeof payload.text !== "string") {
            throw new Error("Expected Telegram message text");
          }
          visible.set(messageId, payload.text);
          return Response.json({
            ok: true,
            result: {
              message_id: messageId,
              date: 0,
              chat: { id: 123, type: "private", first_name: "Fixture" },
              text: payload.text,
            },
          });
        };
        const bot = new Bot("123456:question-fixture", {
          client: { fetch: asTelegramClientFetch(fetch) },
        });
        let questionMessageId: number | undefined;
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await emitToolStart(replyOptions, {
              name: "exec",
              toolCallId: "check",
              phase: "start",
            });
            await vi.advanceTimersByTimeAsync(1500);
            await draft?.flush();
            expect([...visible.values()].some((text) => text.includes("Exec"))).toBe(true);
            await dispatcherOptions.deliver(question, { kind: "tool" });
            questionMessageId = draft?.messageId();
            expect(visible.get(questionMessageId ?? -1)).toBe(question.text);
            await dispatcherOptions.deliver(
              { text: "The question has settled." },
              { kind: "final" },
            );
            return { queuedFinal: true };
          },
        );
        await dispatchWithContext({
          bot,
          cfg: { channels: { telegram: { botToken: "123456:question-fixture" } } },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode,
          telegramCfg: { streaming: { mode: streamMode, progress: { toolProgress: true } } },
        });
        await vi.runOnlyPendingTimersAsync();
        expect(visible.get(questionMessageId ?? -1)).toBe(question.text);
        expect([...visible.values()]).toEqual([question.text, "The question has settled."]);
      } finally {
        await draft?.discard();
        vi.useRealTimers();
      }
    },
  );
});
