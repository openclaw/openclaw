import { expectDefined } from "@openclaw/normalization-core";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createBot,
  createContext,
  createReasoningStreamContext,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliveredReply,
  loadSessionStore,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import type * as TelegramDeliveryModule from "./bot/delivery.replies.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type * as TelegramDraftModule from "./draft-stream.js";
import type * as TelegramEditModule from "./send-edit.js";

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
