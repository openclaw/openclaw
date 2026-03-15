import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
  });

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
    replyToMode: "first",
    streamMode: "partial",
    textLimit: 4096,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    opts: {
      messageId?: number;
      text?: string;
      chatType?: "private" | "group" | "supergroup";
      fromId?: number;
      chatId?: number;
    } = {},
  ) {
    await processMessage(
      {
        message: {
          chat: { id: opts.chatId ?? 123, type: opts.chatType ?? "private", title: "chat" },
          from: opts.fromId != null ? { id: opts.fromId } : undefined,
          message_id: opts.messageId ?? 456,
          text: opts.text,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(context);
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError };
  }

  it("dispatches when context is available", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    const args = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    expect(args.replyToMode).toBe("off");
  });

  it("enables reply threading on rapid consecutive messages", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { text: "hi" });
    await processSampleMessage(processMessage, { messageId: 457, text: "again" });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("first");
  });

  it("disables reply threading when message gap exceeds base 10s window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, {
      text: "this is a longer first message that should not count as dense short input",
    });
    vi.setSystemTime(new Date("2026-03-06T00:00:11.000Z"));
    await processSampleMessage(processMessage, {
      messageId: 458,
      text: "this is another long message past 10s so it should reset",
    });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("off");
    vi.useRealTimers();
  });

  it("expands burst window for dense short messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { text: "1" }); // off
    vi.setSystemTime(new Date("2026-03-06T00:00:08.000Z"));
    await processSampleMessage(processMessage, { messageId: 459, text: "2" }); // first
    vi.setSystemTime(new Date("2026-03-06T00:00:16.000Z"));
    await processSampleMessage(processMessage, { messageId: 460, text: "3" }); // first (20s window)

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(3);
    const third = dispatchTelegramMessage.mock.calls[2]?.[0] as { replyToMode?: string };
    expect(third.replyToMode).toBe("first");
    vi.useRealTimers();
  });

  it("treats rapid group messages from different senders as one burst", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, {
      messageId: 461,
      text: "a",
      chatType: "group",
      fromId: 1,
    });
    await processSampleMessage(processMessage, {
      messageId: 462,
      text: "b",
      chatType: "group",
      fromId: 2,
    });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("first");
  });

  it("honors custom fixed burst windows when learning is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      telegramCfg: {
        replyAdaptive: {
          baseWindowMs: 5_000,
          denseWindowMs: 8_000,
          veryDenseWindowMs: 10_000,
        },
      },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await processSampleMessage(processMessage, { messageId: 463, text: "short" });
    vi.setSystemTime(new Date("2026-03-06T00:00:11.000Z"));
    await processSampleMessage(processMessage, { messageId: 464, text: "short" });

    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(second.replyToMode).toBe("off");
    vi.useRealTimers();
  });

  it("preserves configured reply mode when adaptive logic is disabled", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      telegramCfg: {
        replyAdaptive: {
          enabled: false,
        },
      },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await processSampleMessage(processMessage, { messageId: 468, text: "hello" });

    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("first");
  });

  it("expands burst eligibility with EMA learning when enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      telegramCfg: {
        replyAdaptive: {
          learning: {
            enabled: true,
            shortMessageWeight: 0.9,
          },
        },
      },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await processSampleMessage(processMessage, { messageId: 465, text: "a" });
    vi.setSystemTime(new Date("2026-03-06T00:00:09.000Z"));
    await processSampleMessage(processMessage, { messageId: 466, text: "b" });
    vi.setSystemTime(new Date("2026-03-06T00:00:33.000Z"));
    await processSampleMessage(processMessage, { messageId: 467, text: "c" });

    const third = dispatchTelegramMessage.mock.calls[2]?.[0] as { replyToMode?: string };
    expect(third.replyToMode).toBe("first");
    vi.useRealTimers();
  });

  it("does not evict another chat using a larger learned ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      telegramCfg: {
        replyAdaptive: {
          learning: {
            enabled: true,
            shortMessageWeight: 0,
            baseMinMs: 10_000,
            baseMaxMs: 80_000,
            denseMultiplier: 1,
            veryDenseMultiplier: 1,
          },
        },
      },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await processSampleMessage(processMessage, { messageId: 500, text: "a", chatId: 1 });
    vi.setSystemTime(new Date("2026-03-06T00:00:40.000Z"));
    await processSampleMessage(processMessage, { messageId: 501, text: "a", chatId: 1 });

    vi.setSystemTime(new Date("2026-03-06T00:00:41.000Z"));
    await processSampleMessage(processMessage, { messageId: 600, text: "x", chatId: 2 });

    vi.setSystemTime(new Date("2026-03-06T00:00:52.000Z"));
    await processSampleMessage(processMessage, { messageId: 502, text: "a", chatId: 1 });

    const fourth = dispatchTelegramMessage.mock.calls[3]?.[0] as { replyToMode?: string };
    expect(fourth.replyToMode).toBe("first");
    vi.useRealTimers();
  });

  it("keeps short-message history within learned very-dense window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      telegramCfg: {
        replyAdaptive: {
          learning: {
            enabled: true,
            shortMessageWeight: 1,
            baseMinMs: 10_000,
            baseMaxMs: 60_000,
            denseMultiplier: 1,
            veryDenseMultiplier: 4,
          },
        },
      },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await processSampleMessage(processMessage, { messageId: 700, text: "a" });
    vi.setSystemTime(new Date("2026-03-06T00:00:10.000Z"));
    await processSampleMessage(processMessage, { messageId: 701, text: "b" });
    vi.setSystemTime(new Date("2026-03-06T00:00:20.000Z"));
    await processSampleMessage(processMessage, { messageId: 702, text: "c" });
    vi.setSystemTime(new Date("2026-03-06T00:00:45.000Z"));
    await processSampleMessage(processMessage, { messageId: 703, text: "long long long long" });

    const fourth = dispatchTelegramMessage.mock.calls[3]?.[0] as { replyToMode?: string };
    expect(fourth.replyToMode).toBe("first");
    vi.useRealTimers();
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456 },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
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
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
  });
});
