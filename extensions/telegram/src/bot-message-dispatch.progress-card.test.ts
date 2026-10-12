import { expectDefined } from "@openclaw/normalization-core";
import {
  buildChannelProgressDraftLine,
  createStructuredOutboundPayloadPlan,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  type DispatchReplyWithBufferedBlockDispatcherArgs,
  createReasoningStreamContext,
  expectDeliveredReply,
  loadSessionStore,
  setupDraftStreams,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "./bot/delivery.replies.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";
import type * as TelegramEditModule from "./send-edit.js";

describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  it("keeps a full plan and recent activity after failed named tool items", () => {
    const richMessages = true;
    const commandLines = Array.from({ length: 8 }, (_, index) =>
      buildChannelProgressDraftLine(
        {
          event: "item",
          itemKind: "command",
          itemId: `command-${index}`,
          name: "exec",
          status: "failed",
          meta: `command ${index}`,
        },
        { commandText: "raw" },
      ),
    ).filter((line) => line !== undefined);
    const preview = renderTelegramProgressDraftPreview(
      {
        lines: [
          ...["automations", "read", "browser", "custom_command_runner"].map((name) =>
            buildChannelProgressDraftLine({
              event: "item",
              itemKind: "tool",
              itemId: `failed-${name}`,
              name,
              status: "failed",
            })!,
          ),
          ...commandLines,
        ],
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ],
      },
      { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 300 },
    );
    expect(preview.text).toContain("Inspect");
    expect(preview.text).toContain("Repair");
    expect(preview.text).toContain("Verify");
    expect(preview.text).toContain("command 7");
    expect(preview.text).not.toContain("command 0");
    expect(preview.text).not.toContain("Automations");
    expect(preview.text).not.toContain("Browser");
    expect(preview.text).not.toContain("Custom Command Runner");
  });

  it("shows a fresh named failure before newer activity replaces it", () => {
    const richMessages = false;
    const failed = buildChannelProgressDraftLine({
      event: "item",
      itemKind: "tool",
      name: "read",
      status: "failed",
    })!;
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Repair", status: "in_progress" as const },
      { step: "Verify", status: "pending" as const },
    ];
    const options = { richMessages, toolProgress: true, maxLines: 3, maxLineChars: 300 };
    const initial = renderTelegramProgressDraftPreview({ lines: [failed], plan }, options);
    expect(initial.text).toContain("Read");
    expect(initial.text).toContain("Repair");

    const after = renderTelegramProgressDraftPreview(
      {
        lines: [failed, buildChannelProgressDraftLine({ event: "tool", name: "browser" })!],
        plan,
      },
      options,
    );
    expect(after.text).not.toContain("Read");
    expect(after.text).toContain("Browser");
    expect(after.text).toContain("Repair");
  });

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

function mockTurn(run: (params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<void>) {
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
    await run(params);
    return { queuedFinal: true };
  });
}

function createReasoningFinalDelivery(): (
  params: DispatchReplyWithBufferedBlockDispatcherArgs,
) => Promise<void> {
  const payload = { text: "hidden", isReasoning: true };
  const plan = expectDefined(
    createStructuredOutboundPayloadPlan([payload])[0],
    "prepared reasoning payload",
  );
  return async ({ dispatcherOptions }) => {
    const deliverPrepared = expectDefined(
      dispatcherOptions.deliverPrepared,
      "prepared Telegram delivery",
    );
    await deliverPrepared(plan, { kind: "final" });
  };
}

describeTelegramDispatch("dispatchTelegramMessage reasoning-room-events", () => {
  it("uses agent reasoning defaults in a forum and accepts replacement snapshots before retiring prior messages", async () => {
    vi.useFakeTimers();
    const streams: TelegramDraftStream[] = [];
    const replacementRequested = createDeferred<void>();
    const acceptReplacement = createDeferred<void>();
    try {
      const actualDraft = await vi.importActual<typeof TelegramDraftModule>("./draft-stream.js");
      const actualDelivery = await vi.importActual<typeof TelegramDeliveryModule>(
        "./bot/delivery.replies.js",
      );
      const actualEdit = await vi.importActual<typeof TelegramEditModule>("./send-edit.js");
      createTelegramDraftStream.mockImplementation((params) => {
        const stream = actualDraft.createTelegramDraftStream(params);
        streams.push(stream);
        return stream;
      });
      deliverReplies.mockImplementation(actualDelivery.deliverReplies);
      editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
      loadSessionStore.mockReturnValue({ s1: {} });
      const bot = createBot();
      const visible = new Map<number, string>();
      const sends: Array<{ chatId: string | number; threadId?: number }> = [];
      let nextMessageId = 1001;
      let firstReasoningId: number | undefined;
      let replacementId: number | undefined;
      let replacementAcceptedBeforeRetirement = false;
      vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text, params) => {
        if (text.includes("Second thought")) {
          replacementRequested.resolve();
          await acceptReplacement.promise;
        }
        const messageId = nextMessageId++;
        visible.set(messageId, text);
        sends.push({ chatId, threadId: params?.message_thread_id });
        if (text.includes("Second thought")) {
          replacementId = messageId;
        }
        return {
          message_id: messageId,
          date: 0,
          chat: { id: -100123, type: "supergroup", title: "Fixture", is_forum: true },
          message_thread_id: 88,
          text,
        };
      });
      vi.spyOn(bot.api, "editMessageText").mockImplementation(async (_chatId, messageId, text) => {
        if (typeof text !== "string") {
          throw new Error("Expected a Telegram text edit");
        }
        visible.set(messageId, text);
        return true;
      });
      vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
        if (messageId === firstReasoningId) {
          replacementAcceptedBeforeRetirement =
            visible.get(replacementId ?? -1)?.includes("Second thought") === true;
        }
        visible.delete(messageId);
        return true;
      });
      mockTurn(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({
          text: "<think>Checking the evidence before replying.</think>",
          isReasoningSnapshot: true,
        });
        await vi.advanceTimersByTimeAsync(1500);
        await Promise.all(streams.map((stream) => stream.flush()));
        expect([...visible.values()]).toEqual([
          expect.stringContaining("Checking the evidence before replying."),
        ]);
        firstReasoningId = [...visible.keys()][0];
        await replyOptions?.onReasoningStream?.({
          text: "<think>Reading the logs.\n\nChecking the evidence before replying.</think>",
          isReasoningSnapshot: true,
        });
        await Promise.all(streams.map((stream) => stream.flush()));
        expect([...visible.keys()]).toEqual([firstReasoningId]);
        const snapshot = visible.get(firstReasoningId ?? -1);
        expect(snapshot).toContain("Reading the logs.");
        expect(snapshot?.match(/Checking the evidence before replying/g)).toHaveLength(1);
        expect(snapshot?.indexOf("Reading the logs.")).toBeLessThan(
          snapshot?.indexOf("Checking the evidence") ?? -1,
        );
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onReasoningStream?.({
          text: "<think>Second thought after checking the logs.</think>",
        });
        const replacing = Promise.all(streams.map((stream) => stream.flush()));
        await replacementRequested.promise;
        expect(visible.get(firstReasoningId ?? -1)).toContain("Reading the logs.");
        acceptReplacement.resolve();
        await replacing;
        expect(visible.get(replacementId ?? -1)).toContain(
          "Second thought after checking the logs.",
        );
        await vi.advanceTimersByTimeAsync(4000);
        expect(visible.has(firstReasoningId ?? -1)).toBe(false);
        expect(replacementAcceptedBeforeRetirement).toBe(true);
        await dispatcherOptions.deliver({ text: "Answer in this topic." }, { kind: "final" });
        expect([...visible.entries()]).toEqual([
          [replacementId, expect.stringContaining("Second thought after checking the logs.")],
          [expect.any(Number), "Answer in this topic."],
        ]);
      });
      await dispatchWithContext({
        bot,
        context: createContext({
          ctxPayload: { SessionKey: "s1" } as TelegramMessageContext["ctxPayload"],
          route: { agentId: "ops", accountId: "default" } as TelegramMessageContext["route"],
          msg: {
            chat: { id: -100123, type: "supergroup", is_forum: true },
            message_id: 456,
            message_thread_id: 88,
          } as TelegramMessageContext["msg"],
          chatId: -100123,
          isGroup: true,
          replyThreadId: 88,
          threadSpec: { id: 88, scope: "forum" },
        }),
        cfg: {
          agents: {
            defaults: { reasoningDefault: "off" },
            entries: { Ops: { reasoningDefault: "stream" } },
          },
          channels: { telegram: { botToken: "test-token" } },
        },
      });
      await vi.runOnlyPendingTimersAsync();
      expect([...visible.values()]).toEqual(["Answer in this topic."]);
      expect(sends.map(({ chatId, threadId }) => [chatId, threadId])).toEqual([
        [-100123, 88],
        [-100123, 88],
        [-100123, 88],
      ]);
    } finally {
      acceptReplacement.resolve();
      await Promise.all(streams.map((stream) => stream.discard()));
      vi.useRealTimers();
    }
  });

  it("routes prepared typed reasoning-only finals to the reasoning lane when reasoning streams", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(createReasoningFinalDelivery());
    await dispatchWithContext({ context: createReasoningStreamContext() });
    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "🧠 _hidden_",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(answerDraftStream.update).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("suppresses whitespace-form internal prefixes until one visible final", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "< / internal", isReasoning: true },
        { kind: "block" },
      );
      expect(reasoningDraftStream.update).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      await dispatcherOptions.deliver({ text: "VISIBLE" }, { kind: "final" });
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "VISIBLE",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes prepared typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    mockTurn(createReasoningFinalDelivery());
    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });
    expectDeliveredReply(0, { text: "🧠 _hidden_" });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
  });

  it("does not persist typed reasoning-only finals in progress stream mode", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(answerDraftStream.update).not.toHaveBeenCalled();
  });
});
