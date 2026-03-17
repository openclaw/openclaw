import { beforeEach, describe, expect, it, vi } from "vitest";
const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext
}));
vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage
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
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    opts: {}
  };
  async function processSampleMessage(processMessage) {
    await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456
        }
      },
      [],
      [],
      {}
    );
  }
  function createDispatchFailureHarness(context, sendMessage) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(context);
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError }
    });
    return { processMessage, runtimeError };
  }
  it("dispatches when context is available", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });
  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(void 0);
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456 },
        route: { sessionKey: "agent:main:main" }
      },
      sendMessage
    );
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 }
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
  });
  it("swallows fallback delivery failures after dispatch throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" }
      },
      sendMessage
    );
    await expect(processSampleMessage(processMessage)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      void 0
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("dispatch exploded"));
  });
});
