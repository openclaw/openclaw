import { Bot } from "grammy";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import {
  createContext,
  createDirectSessionPayload,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  emitToolStart,
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "./bot/delivery.replies.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import type * as TelegramEditModule from "./send-edit.js";

const question = {
  text: "Should this harmless check continue?",
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
};

describeTelegramDispatch("dispatchTelegramMessage native questions", () => {
  it.each([
    { streamMode: "progress", controls: "buttons", rejectControls: false },
    { streamMode: "progress", controls: "buttonless", rejectControls: false },
    { streamMode: "partial", controls: "buttons", rejectControls: true },
  ] as const)(
    "keeps the accepted $controls question on the $streamMode stream (controls rejected: $rejectControls)",
    async ({ streamMode, controls, rejectControls }) => {
      vi.useFakeTimers();
      let draft: TelegramDraftStream | undefined;
      const register = vi
        .spyOn(questionGatewayRuntime, "registerChannelDelivery")
        .mockImplementation(() => {});
      const statusReactionController = createStatusReactionController();
      try {
        const actualDraft = await vi.importActual<typeof TelegramDraftModule>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof TelegramDeliveryModule>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof TelegramEditModule>("./send-edit.js");
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        deliverReplies.mockImplementation(actualDelivery.deliverReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        editMessageReplyMarkupTelegram.mockImplementation(
          actualEdit.editMessageReplyMarkupTelegram,
        );
        const visible = new Map<number, string>();
        const keyboards = new Map<number, unknown>();
        let nextMessageId = 1001;
        let rejectedControlEdits = 0;
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
            keyboards.delete(messageId);
            return Response.json({ ok: true, result: true });
          }
          if (method === "editMessageText" && payload.reply_markup && rejectControls) {
            rejectedControlEdits += 1;
            return Response.json({
              ok: false,
              error_code: 400,
              description: "Bad Request: BUTTON_DATA_INVALID",
            });
          }
          if (method === "editMessageReplyMarkup") {
            keyboards.set(messageId, payload.reply_markup);
            return Response.json({ ok: true, result: true });
          }
          if (method !== "sendMessage" && method !== "editMessageText") {
            throw new Error(`Unexpected Telegram method: ${method}`);
          }
          if (typeof payload.text !== "string") {
            throw new Error("Expected Telegram message text");
          }
          visible.set(messageId, payload.text);
          if (payload.reply_markup !== undefined) {
            keyboards.set(messageId, payload.reply_markup);
          }
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
            await dispatcherOptions.deliver(
              {
                ...question,
                channelData: {
                  ...question.channelData,
                  ...(controls === "buttons"
                    ? {
                        telegram: {
                          buttons: [[{ text: "Continue", callback_data: "ask:continue" }]],
                        },
                      }
                    : {}),
                },
              },
              { kind: "tool" },
            );
            questionMessageId = draft?.messageId();
            expect(visible.get(questionMessageId ?? -1)).toBe(
              "Should this harmless check continue?",
            );
            await emitToolStart(replyOptions, { name: "wait", toolCallId: "wait", phase: "start" });
            await vi.advanceTimersByTimeAsync(1500);
            await draft?.flush();
            expect(visible.get(questionMessageId ?? -1)).toBe(
              "Should this harmless check continue?",
            );
            if (controls === "buttons") {
              expect(keyboards.get(questionMessageId ?? -1)).toEqual({
                inline_keyboard: [[{ text: "Continue", callback_data: "ask:continue" }]],
              });
            }
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
            statusReactionController,
          }),
          streamMode,
          telegramCfg: { streaming: { mode: streamMode, progress: { toolProgress: true } } },
        });
        await vi.runOnlyPendingTimersAsync();
        if (rejectControls) {
          expect(rejectedControlEdits).toBe(1);
          expect(register).not.toHaveBeenCalled();
          expect([...visible.values()]).toEqual(["Should this harmless check continue?"]);
          expect([...keyboards.values()]).toEqual([]);
          expect(statusReactionController.setError).toHaveBeenCalledOnce();
          expect(emitTelegramMessageSentHooks).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, messageId: [...visible.keys()][0] }),
          );
        } else {
          expect([...visible.values()]).toEqual([
            "Should this harmless check continue?",
            "The question has settled.",
          ]);
          expect(register).toHaveBeenCalledOnce();
          const registration = register.mock.calls[0]?.[0];
          expect(registration?.questionId).toBe("ask_0123456789abcdef0123456789abcdef");
          expect(registration?.deliveryId).toBe(`telegram:default:123:${questionMessageId}`);
          await registration?.finalize("Answered: continue");
          expect(visible.get(questionMessageId ?? -1)).toContain("Answered: continue");
          expect(keyboards.get(questionMessageId ?? -1)).toEqual({ inline_keyboard: [] });
          expect([...visible.values()]).toContain("The question has settled.");
        }
      } finally {
        await draft?.discard();
        register.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
