import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS } from "./long-turn-delivery.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const telegramInboundInfo = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: telegramInboundInfo,
    }),
  }),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;
let formatTelegramInboundLogLine: typeof import("./bot-message.js").formatTelegramInboundLogLine;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({ createTelegramMessageProcessor, formatTelegramInboundLogLine } =
      await import("./bot-message.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockReset();
    telegramInboundInfo.mockClear();
    upsertChannelPairingRequest.mockClear();
  });

  const telegramDepsForTest = {
    upsertChannelPairingRequest,
  } as unknown as TelegramBotDeps;

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    telegramDeps: telegramDepsForTest,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    lifecycle?: import("./bot-message.js").TelegramMessageProcessorLifecycle,
  ) {
    return await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
      undefined,
      undefined,
      undefined,
      lifecycle,
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError };
  }

  function createMessageContext(context: Record<string, unknown> = {}) {
    return {
      chatId: 123,
      ctxPayload: {
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        RawBody: "hello there",
      },
      primaryCtx: { me: { username: "openclaw_bot" } },
      route: { sessionKey: "agent:main:main" },
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    };
  }

  it("dispatches when context is available", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
    expect(telegramInboundInfo).toHaveBeenCalledWith(
      "Inbound message telegram:123 -> @openclaw_bot (direct, 11 chars)",
    );
  });

  it("defers long-running message turns after the soft deadline", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let resolveDispatch: (() => void) | undefined;
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        threadSpec: { id: 456, scope: "forum" },
      }),
    );
    dispatchTelegramMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      }),
    );
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    try {
      const processPromise = processSampleMessage(processMessage);
      await vi.advanceTimersByTimeAsync(TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS - 1);
      expect(sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(processPromise).resolves.toBe(true);

      const dispatchParams = dispatchTelegramMessage.mock.calls[0]?.[0] as
        | {
            runId?: string;
            longTurnDeliveryState?: { runId: string; isDeferred: () => boolean };
          }
        | undefined;
      const runId = dispatchParams?.runId;
      expect(runId).toEqual(expect.any(String));
      expect(dispatchParams?.longTurnDeliveryState?.runId).toBe(runId);
      expect(dispatchParams?.longTurnDeliveryState?.isDeferred()).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(
        123,
        `Still working on this. I will reply here when the run completes.\n\nRun: ${runId}`,
        { message_thread_id: 456 },
      );

      resolveDispatch?.();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a deferral notice when final delivery already started", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let resolveDispatch: (() => void) | undefined;
    let processResolved = false;
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        threadSpec: { id: 456, scope: "forum" },
      }),
    );
    dispatchTelegramMessage.mockImplementation((params) => {
      (
        params as {
          longTurnDeliveryState?: { markFinalDeliveryStarted: () => void };
        }
      ).longTurnDeliveryState?.markFinalDeliveryStarted();
      return new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });
    });
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    try {
      const processPromise = processSampleMessage(processMessage).then((result) => {
        processResolved = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(processResolved).toBe(false);

      resolveDispatch?.();
      await expect(processPromise).resolves.toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a deferral notice when dispatch is no longer deliverable", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let resolveDispatch: (() => void) | undefined;
    let processResolved = false;
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        threadSpec: { id: 456, scope: "forum" },
      }),
    );
    dispatchTelegramMessage.mockImplementation((params) => {
      (
        params as {
          longTurnDeliveryState?: { setCanSendDeferralNotice: (check: () => boolean) => void };
        }
      ).longTurnDeliveryState?.setCanSendDeferralNotice(() => false);
      return new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });
    });
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    try {
      const processPromise = processSampleMessage(processMessage).then((result) => {
        processResolved = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(processResolved).toBe(false);

      resolveDispatch?.();
      await expect(processPromise).resolves.toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not defer group turns before visible reply eligibility is known", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let resolveDispatch: (() => void) | undefined;
    let processResolved = false;
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        isGroup: true,
        threadSpec: { id: undefined, scope: "none" },
        ctxPayload: {
          From: "telegram:group:-100",
          To: "@openclaw_bot",
          ChatType: "group",
          RawBody: "@bot think for a while",
        },
      }),
    );
    dispatchTelegramMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      }),
    );
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    try {
      const processPromise = processSampleMessage(processMessage).then((result) => {
        processResolved = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(processResolved).toBe(false);

      resolveDispatch?.();
      await expect(processPromise).resolves.toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports deferred background dispatch failures with run context", async () => {
    vi.useFakeTimers();
    let resolveFailureSend: (() => void) | undefined;
    const failureSent = new Promise<void>((resolve) => {
      resolveFailureSend = resolve;
    });
    const sendMessage = vi.fn(async (_chatId: number, _text: string, _options?: unknown) => {
      if (sendMessage.mock.calls.length === 2) {
        resolveFailureSend?.();
      }
    });
    let rejectDispatch: ((error: unknown) => void) | undefined;
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        threadSpec: { id: 456, scope: "forum" },
      }),
    );
    dispatchTelegramMessage.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectDispatch = reject;
      }),
    );
    const runtimeError = vi.fn();
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    try {
      const processPromise = processSampleMessage(processMessage);
      await vi.advanceTimersByTimeAsync(TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS);
      await expect(processPromise).resolves.toBe(true);

      const dispatchParams = dispatchTelegramMessage.mock.calls[0]?.[0] as
        | { runId?: string }
        | undefined;
      const runId = dispatchParams?.runId;
      expect(sendMessage).toHaveBeenCalledTimes(1);

      rejectDispatch?.(new Error("provider down"));
      await failureSent;

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[1]?.[1]).toContain(
        "The deferred run did not complete successfully.",
      );
      expect(sendMessage.mock.calls[1]?.[1]).toContain(`Run: ${runId}`);
      expect(sendMessage.mock.calls[1]?.[1]).not.toContain("provider down");
      expect(sendMessage.mock.calls[1]?.[1]).not.toContain("Something went wrong");
      expect(sendMessage.mock.calls[1]?.[2]).toEqual({ message_thread_id: 456 });
      expect(runtimeError).toHaveBeenCalledWith(
        "telegram deferred dispatch failed: Error: provider down",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      onDispatchStart.mock.invocationCallOrder[0],
    );
    expect(onDispatchStart.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(false);

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not send early typing cues for room events", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
        ctxPayload: {
          From: "telegram:123",
          To: "telegram:123",
          ChatType: "group",
          RawBody: "ambient",
          InboundEventKind: "room_event",
        },
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(false);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
    expect(telegramInboundInfo).not.toHaveBeenCalled();
  });

  it("formats Telegram inbound summaries without message content", () => {
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:123",
        to: "@openclaw_bot",
        chatType: "direct",
        body: "secret message",
      }),
    ).toBe("Inbound message telegram:123 -> @openclaw_bot (direct, 14 chars)");
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:group:-100",
        to: "@openclaw_bot",
        chatType: "group",
        body: "<media:image>",
        mediaType: "image/jpeg",
      }),
    ).toBe("Inbound message telegram:group:-100 -> @openclaw_bot (group, image/jpeg, 13 chars)");
  });

  it("keeps dispatch running when the early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("omits message_thread_id for General-topic fallback replies", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 1, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
  });

  it("swallows fallback delivery failures after dispatch throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });
});
