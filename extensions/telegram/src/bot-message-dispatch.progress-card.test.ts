import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  emitToolStart,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
} from "./bot-message-dispatch.test-harness.js";
import type { DispatchReplyWithBufferedBlockDispatcherArgs } from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "./bot/delivery.replies.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import type * as TelegramEditModule from "./send-edit.js";

describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  // The real compositor, renderer and transport expose short sends, stopped
  // streams and lifecycle resets at Telegram's stubbed network boundary.
  it.each([
    { mode: "progress", finalDelivery: "dispatcher" },
    { mode: "progress", finalDelivery: "message-tool" },
  ] as const)(
    "keeps cards and accepted answers across tool, final and queued transitions ($mode, $finalDelivery)",
    async ({ mode, finalDelivery }) => {
      vi.useFakeTimers();
      try {
        let queuedReplyOptions: DispatchReplyWithBufferedBlockDispatcherArgs["replyOptions"];
        const actualDraft = await vi.importActual<typeof TelegramDraftModule>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof TelegramDeliveryModule>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof TelegramEditModule>("./send-edit.js");
        deliverReplies.mockImplementation(actualDelivery.deliverStructuredReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        let draft: TelegramDraftStream | undefined;
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        const bot = createBot();
        let nextMessageId = 1001;
        const visible = new Map<number, string>();
        const send = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => {
          const message_id = nextMessageId++;
          visible.set(message_id, text);
          return {
            message_id,
            date: 0,
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text,
          };
        });
        const edit = vi
          .spyOn(bot.api, "editMessageText")
          .mockImplementation(async (_chatId, messageId, text) => {
            if (typeof text !== "string") {
              throw new Error("Expected a plain-text Telegram edit");
            }
            visible.set(messageId, text);
            return true;
          });
        vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
          visible.delete(messageId);
          return true;
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            queuedReplyOptions = replyOptions;
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect(send).not.toHaveBeenCalled();

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Working",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()]).toEqual(["<b>Working</b>"]);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "1/2 complete",
              steps: [
                { step: "Inspect", status: "completed" },
                { step: "Repair", status: "in_progress" },
              ],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()][0]).toContain("[x] Inspect");
            expect([...visible.values()][0]).not.toContain("Working");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await vi.advanceTimersByTimeAsync(4_000);
            expect(visible.size).toBe(0);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Resumed",
              steps: [{ step: "Resume work", status: "in_progress" }],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(2);
            expect([...visible.values()][0]).toContain("<b>Resumed</b>");
            expect([...visible.values()][0]).toContain("Resume work (in progress)");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onItemEvent?.({
              kind: "tool",
              name: "progress_card",
              itemId: "blocked-card",
              status: "blocked",
            });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Resume work (in progress)");
            expect([...visible.values()][0]).toContain("Progress Card");
            expect([...visible.values()][0]).toContain("blocked");

            await replyOptions?.onBlockReplyQueued?.({ text: "Checking the result" });
            await dispatcherOptions.deliver({ text: "Checking the result" }, { kind: "block" });

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onToolStart?.({
              phase: "start",
              name: "exec",
              toolCallId: "exec-proof",
              args: { command: "printf proof" },
            });
            await replyOptions?.onItemEvent?.({
              itemId: "tool:exec-proof",
              toolCallId: "exec-proof",
              name: "exec",
              kind: "tool",
              phase: "start",
              status: "running",
              title: "Exec",
            });
            await replyOptions?.onReasoningEnd?.();
            await draft?.flush();
            const resumedCard = [...visible.values()].find((text) => text.includes("Exec"));
            expect(resumedCard).toContain("Resume work (in progress)");
            expect(resumedCard).toContain("blocked");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            const toolCard = [...visible.values()].find((text) => text.includes("Exec"));
            expect(toolCard).not.toContain("Resumed");
            expect(toolCard).not.toContain("Resume work");

            await replyOptions?.onAssistantMessageStart?.();
            if (finalDelivery === "message-tool") {
              await bot.api.sendMessage(123, "Done");
              await replyOptions?.onObservedReplyDelivery?.();
              await vi.advanceTimersByTimeAsync(4_000);
              // NO_REPLY never enters the final dispatcher; retire before turn settlement.
              expect.soft([...visible.values()]).toEqual(["Done"]);
            } else {
              await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
            }
            expect([...visible.values()]).toContain("Done");
            const finalMessages = [...visible.entries()];
            const sendsAfterFinal = send.mock.calls.length;
            const editsAfterFinal = edit.mock.calls.length;
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Late card",
              steps: [],
            });
            await replyOptions?.onToolStart?.({
              name: "exec",
              phase: "start",
              toolCallId: "late-raw",
            });
            await replyOptions?.onItemEvent?.({
              itemId: "tool:late-prepared",
              toolCallId: "late-prepared",
              kind: "tool",
              name: "exec",
              title: "Late prepared tool",
              phase: "start",
              status: "running",
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(sendsAfterFinal);
            expect(edit).toHaveBeenCalledTimes(editsAfterFinal);
            expect([...visible.entries()]).toEqual(finalMessages);
            return { queuedFinal: finalDelivery === "dispatcher" };
          },
        );

        await dispatchWithContext({
          bot,
          cfg: {
            agents: { defaults: { reasoningDefault: "stream" } },
            channels: { telegram: { botToken: "test-token" } },
          },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: mode,
          telegramCfg: {
            streaming: {
              mode,
              progress: { toolProgress: true },
              preview: { toolProgress: true },
            },
          },
        });
        await vi.runOnlyPendingTimersAsync();
        expect([...visible.values()]).toEqual(["Done"]);
        if (finalDelivery === "dispatcher") {
          const finalMessageId = [...visible.keys()][0];
          await queuedReplyOptions?.onQueuedFollowupAdmitted?.();
          await emitToolStart(queuedReplyOptions, {
            name: "exec",
            toolCallId: "followup",
            phase: "start",
          });
          await vi.advanceTimersByTimeAsync(1500);
          await draft?.flush();
          expect(visible.get(finalMessageId ?? -1)).toBe("Done");
          expect([...visible.entries()].filter(([id]) => id !== finalMessageId)).toEqual([
            [expect.any(Number), expect.stringContaining("Exec")],
          ]);
          await queuedReplyOptions?.onQueuedFollowupSettled?.();
          await vi.runOnlyPendingTimersAsync();
          expect([...visible.entries()]).toEqual([[finalMessageId, "Done"]]);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
