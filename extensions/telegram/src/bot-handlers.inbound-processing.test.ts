import type { Message } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";
import { createTelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramContext } from "./bot/types.js";

function createHarness(
  processMessageWithReplyChain = vi.fn<TelegramMessagePipeline["processMessageWithReplyChain"]>(
    async () => ({ kind: "completed" }),
  ),
) {
  const cfg = { messages: { inbound: { debounceMs: 50 } }, commands: { useAccessGroups: false } };
  const message = {
    resolveMediaRuntime: () => ({ token: "test-token" }),
    recordMessageResolvedMedia: vi.fn(),
    promptContextBoundaryOptions: () => ({}),
    latestPromptContextMinTimestampMs: () => undefined,
    latestPromptContextAmbientWatermark: () => undefined,
    mergeDispatchDedupeClaims: () => [],
    releaseDispatchDedupeClaims: vi.fn(),
    buildFailedProcessingResult: (error: unknown) => ({ kind: "failed-retryable", error }),
    settleSpooledReplayParticipants: vi.fn(),
    createSpooledReplayParticipantForBufferedWork: () => undefined,
    spooledReplayOptions: () => ({}),
    buildSyntheticTextMessage: ({ base, text }: { base: Message; text: string }) => ({
      ...base,
      text,
    }),
    buildSyntheticContext: (ctx: TelegramContext, syntheticMessage: Message) => ({
      ...ctx,
      message: syntheticMessage,
    }),
    formatTelegramAmbientTranscriptBody: () => undefined,
    processMessageWithReplyChain,
  } as unknown as TelegramMessagePipeline;
  const { processInboundMessage } = createTelegramInboundProcessing({
    params: {
      cfg,
      accountId: "default",
      bot: { api: { sendMessage: vi.fn() } },
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      opts: { token: "test-token" },
      mediaMaxBytes: 10_000,
      logger: { warn: vi.fn() },
    } as unknown as RegisterTelegramHandlerParams,
    message,
  });
  let messageId = 0;
  const send = (threadId: number, text: string, forwarded = false) => {
    const msg = {
      message_id: ++messageId,
      date: 1,
      chat: { id: 42, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      message_thread_id: threadId,
      is_topic_message: true,
      text,
      ...(forwarded
        ? { forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Bob" } }
        : {}),
    } as Message;
    return processInboundMessage({
      authorizationCfg: cfg,
      ctx: { message: msg, me: { id: 123, username: "test_bot" } } as TelegramContext,
      msg,
      chatId: 42,
      isGroup: false,
      isForum: false,
      threadSpec: { scope: "dm", id: threadId },
      dmPolicy: "open",
      storeAllowFrom: [],
      senderId: "42",
      effectiveGroupAllow: normalizeAllowFrom(),
      effectiveDmAllow: normalizeAllowFrom(["42"]),
      channelIngressResolver: vi.fn(),
      sendOversizeWarning: false,
      oversizeLogMessage: "media too large",
      dispatchDedupeClaims: [],
    });
  };
  return { send, processMessageWithReplyChain };
}

describe("Telegram private-topic inbound isolation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces one topic without merging another topic's text or reply target", async () => {
    const { send, processMessageWithReplyChain } = createHarness();
    await send(100, "first A");
    await send(200, "only B");
    await send(100, "second A");
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(2);
    expect(
      processMessageWithReplyChain.mock.calls.map(([entry]) => ({
        text: entry.msg.text,
        thread: entry.options?.threadSpec,
        messageThread: entry.msg.message_thread_id,
      })),
    ).toEqual(
      expect.arrayContaining([
        { text: "first A\nsecond A", thread: { scope: "dm", id: 100 }, messageThread: 100 },
        { text: "only B", thread: { scope: "dm", id: 200 }, messageThread: 200 },
      ]),
    );
  });

  it("admits another topic while the first topic's downstream processing is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async ({ options }) => {
      if (options?.threadSpec?.id === 100) {
        await pending;
      }
      return { kind: "completed" };
    });
    const { send } = createHarness(processMessageWithReplyChain);
    try {
      await send(100, "long-running A");
      await vi.advanceTimersByTimeAsync(100);
      await send(100, "queued A");
      await send(200, "independent B");
      await vi.advanceTimersByTimeAsync(100);
      expect(processMessageWithReplyChain.mock.calls.map(([entry]) => entry.msg.text)).toEqual([
        "long-running A",
        "independent B",
      ]);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(processMessageWithReplyChain.mock.calls.map(([entry]) => entry.msg.text)).toEqual([
      "long-running A",
      "independent B",
      "queued A",
    ]);
  });

  it.each([false, true])(
    "cancels only the stopped topic's buffered lane (forwarded: %s)",
    async (forwarded) => {
      const { send, processMessageWithReplyChain } = createHarness();
      await send(100, "preserve A", forwarded);
      await send(200, "cancel B", forwarded);
      await send(200, "/stop");
      await vi.advanceTimersByTimeAsync(100);

      expect(processMessageWithReplyChain.mock.calls.map(([entry]) => entry.msg.text)).toEqual([
        "/stop",
        "preserve A",
      ]);
      expect(processMessageWithReplyChain.mock.calls[1]?.[0].options?.threadSpec).toEqual({
        scope: "dm",
        id: 100,
      });
    },
  );
});
