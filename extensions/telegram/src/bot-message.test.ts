import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({ createTelegramMessageProcessor } = await import("./bot-message.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
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
    options: Parameters<ReturnType<typeof createTelegramMessageProcessor>>[3] = {},
  ) {
    await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      options,
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue({
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    });
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError };
  }

  it("dispatches when context is available and sends admitted early typing", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 123,
      ctxPayload: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        ChatType: "direct",
      },
      route: { sessionKey: "agent:main:main" },
      sendTyping,
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
  });

  it("suppresses early typing for Telegram system events", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 123,
      ctxPayload: {
        Provider: "cron-event",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        ChatType: "direct",
      },
      route: { sessionKey: "agent:main:main" },
      sendTyping,
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { systemEvent: true });

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("suppresses early typing for internal background run kinds", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 123,
      ctxPayload: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        ChatType: "direct",
      },
      route: { sessionKey: "agent:main:main" },
      sendTyping,
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { runKind: "background-internal" });

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("keeps dispatch running when the admitted early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue({
      chatId: 123,
      ctxPayload: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:123",
        ChatType: "direct",
      },
      route: { sessionKey: "agent:main:main" },
      sendTyping,
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);

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
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
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
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();

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
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
  });
});
