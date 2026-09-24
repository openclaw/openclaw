import { Bot } from "grammy";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createRuntime,
  createDirectSessionPayload,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  emitToolStart,
  expectDeliveredReply,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
} from "./bot-message-dispatch.test-harness.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import type { TelegramDraftStream } from "./draft-stream.js";

describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  it.each(["confirmed", "staged", "unconfirmed", "absent"] as const)(
    "requires a confirmed visible receipt for continuation custody (%s)",
    async (receipt) => {
      const draft = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draft);
      const adopt = vi.fn(async () => true);
      const waitingText = "Waiting for delegated work.";
      const payload = { text: waitingText };
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          if (receipt !== "absent") {
            await emitToolStart(replyOptions, {
              name: "exec",
              phase: "start",
              toolCallId: "delegate",
            });
          }
          if (receipt === "staged") {
            draft.lastDeliveredText.mockReturnValue("");
          } else if (receipt === "unconfirmed") {
            draft.messageId.mockReturnValue(undefined);
            draft.sendMayHaveLanded.mockReturnValue(true);
          }
          // Earlier skipped output must not cause a fallback after a retained card.
          dispatcherOptions.onSkip?.({}, { kind: "block", reason: "empty" });
          await dispatcherOptions.deliver(payload, {
            kind: "final",
            adoptProgressContinuation: adopt,
          });
          return { queuedFinal: true };
        },
      );
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      });

      if (receipt === "confirmed") {
        expect(adopt).toHaveBeenCalledOnce();
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(draft.clear).not.toHaveBeenCalled();
      } else {
        expect(adopt).not.toHaveBeenCalled();
        expectDeliveredReply(0, { text: waitingText });
      }
    },
  );

  it.each([
    { kind: "media", content: { mediaUrl: "https://example.com/report.pdf" } },
    {
      kind: "buttons",
      content: {
        channelData: { telegram: { buttons: [[{ text: "Continue", callback_data: "go" }]] } },
      },
    },
  ])(
    "delivers $kind alongside a waiting payload instead of adopting only its card",
    async ({ content }) => {
      createTelegramDraftStream.mockReturnValue(createSequencedDraftStream(2001));
      const adopt = vi.fn(async () => true);
      const payload = { text: "Waiting for delegated work.", ...content };
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await emitToolStart(replyOptions, {
            name: "exec",
            phase: "start",
            toolCallId: "delegate",
          });
          await dispatcherOptions.deliver(payload, {
            kind: "final",
            adoptProgressContinuation: adopt,
          });
          return { queuedFinal: true };
        },
      );
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      });

      expect(adopt).not.toHaveBeenCalled();
      expectDeliveredReply(0, { text: payload.text, ...content });
    },
  );

  it.each([
    { commentary: false, richMessages: false },
    { commentary: false, richMessages: true },
    { commentary: true, richMessages: false },
    { commentary: true, richMessages: true },
  ])(
    "publishes complete preambles through transport ($commentary, $richMessages)",
    async ({ commentary, richMessages }) => {
      vi.useFakeTimers();
      let draft: TelegramDraftStream | undefined;
      const runtime = createRuntime();
      try {
        const actualDraft =
          await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof import("./send-edit.js")>("./send-edit.js");
        deliverReplies.mockImplementation(actualDelivery.deliverReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        const visible = new Map<number, string>();
        const writes: string[] = [];
        let nextMessageId = 1001;
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const method = new URL(input instanceof Request ? input.url : String(input)).pathname
            .split("/")
            .at(-1);
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON Telegram request");
          }
          const payload: Record<string, unknown> = JSON.parse(init.body);
          const messageId =
            "message_id" in payload && typeof payload.message_id === "number"
              ? payload.message_id
              : nextMessageId++;
          if (method === "deleteMessage") {
            visible.delete(messageId);
            return Response.json({ ok: true, result: true });
          }
          if (
            method !== "sendMessage" &&
            method !== "sendRichMessage" &&
            method !== "editMessageText"
          ) {
            throw new Error(`Unexpected Telegram method: ${method}`);
          }
          const text =
            "rich_message" in payload
              ? JSON.stringify(payload.rich_message)
              : "text" in payload && typeof payload.text === "string"
                ? payload.text
                : "";
          visible.set(messageId, text);
          writes.push(text);
          return Response.json({
            ok: true,
            result: {
              message_id: messageId,
              date: 0,
              chat: { id: 123, type: "private", first_name: "Fixture" },
              text,
            },
          });
        };
        const bot = new Bot("123456:progress-fixture", {
          client: { fetch: asTelegramClientFetch(fetch) },
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            const preamble = async (
              itemId: string,
              progressText: string,
              phase?: "start" | "update" | "end",
            ) => {
              await replyOptions?.onItemEvent?.({ kind: "preamble", itemId, phase, progressText });
              await draft?.flush();
            };
            await replyOptions?.onReplyStart?.();
            await replyOptions?.onItemEvent?.({
              kind: "preamble",
              itemId: "previous",
              phase: "end",
              progressText: "Checking the samples.",
            });
            await replyOptions?.onItemEvent?.({
              itemId: "tool:work",
              name: "exec",
              toolCallId: "work",
              kind: "tool",
              phase: "start",
              status: "running",
              title: "Check samples",
            });
            await replyOptions?.onToolStart?.({ name: "exec", toolCallId: "work", phase: "start" });
            await vi.advanceTimersByTimeAsync(1_500);
            await draft?.flush();
            expect(writes.at(-1)).toContain("Checking the samples.");
            const previousWrites = [...writes];
            for (const [phase, progressText] of [
              ["start", "2"],
              ["update", "2 of"],
              ["update", "2 of 8 samples are checked."],
            ] as const) {
              await preamble("current", progressText, phase);
              expect.soft(writes).toEqual(previousWrites);
            }
            await preamble("current", "2 of 8 samples are checked.", "end");
            expect(writes.at(-1)).toContain("2 of 8 samples are checked.");
            await preamble("previous", "", "update");
            expect(writes.at(-1)).toContain("2 of 8 samples are checked.");
            expect(writes.at(-1)).not.toContain("Checking the samples.");
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Verifying samples",
              steps: [{ step: "Verify samples", status: "in_progress" }],
            });
            await preamble("after-plan", "All samples are **checked**.", "end");
            expect(writes.at(-1)).toContain("Verify samples");
            expect(writes.at(-1)).toContain("All samples are");
            expect(writes.at(-1)).toContain("checked");
            await preamble("after-plan", "", "start");
            expect(writes.at(-1)).not.toContain("All samples are");
            expect(writes.at(-1)).toContain("Verify samples");
            await preamble("complete-producer", "Verification finished.");
            expect(writes.at(-1)).toContain("Verification finished.");
            await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
            const finalWrites = [...writes];
            await preamble("late", "Late update", "end");
            await preamble("complete-producer", "", "update");
            expect(writes).toEqual(finalWrites);
            return { queuedFinal: true };
          },
        );
        await dispatchWithContext({
          runtime,
          bot,
          cfg: { channels: { telegram: { botToken: "123456:progress-fixture" } } },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: "progress",
          telegramCfg: {
            richMessages,
            streaming: {
              mode: "progress",
              progress: { toolProgress: true, commentary, label: false },
            },
          },
        });
        await vi.runOnlyPendingTimersAsync();
        expect(runtime.error).not.toHaveBeenCalled();
        expect(visible.size).toBe(1);
        expect([...visible.values()][0]).toContain("Done");
      } finally {
        await draft?.discard();
        vi.useRealTimers();
      }
    },
  );

  it.each(["progress", "partial", "block"] as const)(
    "retains the plan across an answer-to-tool transition in %s mode",
    async (mode) => {
      const draft = createSequencedDraftStream();
      createTelegramDraftStream.mockReturnValue(draft);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onAssistantMessageStart?.();
          await replyOptions?.onPlanUpdate?.({
            phase: "update",
            explanation: "Checking the change",
            steps: [{ step: "Verify delivery", status: "in_progress" }],
          });
          await replyOptions?.onItemEvent?.({
            itemId: "tool:read",
            toolCallId: "read",
            name: "Read",
            kind: "tool",
            phase: "start",
            status: "running",
            title: "Read",
          });
          await replyOptions?.onToolStart?.({ name: "Read", toolCallId: "read", phase: "start" });
          if (mode === "partial") {
            await replyOptions?.onPartialReply?.({ text: "Checking the result" });
          } else {
            await replyOptions?.onBlockReplyQueued?.({ text: "Checking the result" });
            await dispatcherOptions.deliver({ text: "Checking the result" }, { kind: "block" });
          }
          await replyOptions?.onAssistantMessageStart?.();
          await replyOptions?.onItemEvent?.({
            itemId: "tool:exec",
            toolCallId: "exec",
            name: "exec",
            kind: "tool",
            phase: "start",
            status: "running",
            title: "Exec",
          });
          await replyOptions?.onToolStart?.({ name: "exec", toolCallId: "exec", phase: "start" });
          return { queuedFinal: false };
        },
      );

      await dispatchWithContext({
        context: createContext(),
        streamMode: mode,
        telegramCfg: {
          streaming: {
            mode,
            progress: { toolProgress: true, label: false },
            preview: { toolProgress: true },
          },
        },
      });
      const preview = draft.updatePreview.mock.calls.at(-1)?.[0].text;
      expect(preview).toContain("Verify delivery (in progress)");
      expect(preview).toContain("Exec");
      if (mode === "progress") {
        expect(preview).toContain("Read");
      } else {
        expect(preview).not.toContain("Read");
      }
    },
  );

  // The real compositor, renderer and transport expose short sends, stopped
  // streams and lifecycle resets at Telegram's stubbed network boundary.
  it.each([
    { mode: "progress", finalDelivery: "dispatcher" },
    { mode: "partial", finalDelivery: "dispatcher" },
    { mode: "block", finalDelivery: "dispatcher" },
    { mode: "progress", finalDelivery: "message-tool" },
  ] as const)(
    "replaces, clears and resumes a short card before the $finalDelivery final in $mode mode",
    async ({ mode, finalDelivery }) => {
      vi.useFakeTimers();
      try {
        const actualDraft =
          await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof import("./send-edit.js")>("./send-edit.js");
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
            expect([...visible.values()][0]).toContain("Resume work (in progress)");
            expect([...visible.values()][0]).toContain("blocked");
            expect([...visible.values()][0]).toContain("Exec");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Exec");
            expect([...visible.values()][0]).toContain("blocked");
            expect([...visible.values()][0]).not.toContain("Resumed");
            expect([...visible.values()][0]).not.toContain("Resume work");
            expect(send).toHaveBeenCalledTimes(2);

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
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
