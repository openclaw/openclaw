import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleFixture,
  createFeishuLifecycleReplyDispatcher,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  expectFeishuSingleEffectAcrossReplay,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
  stopFeishuLifecycleMonitors,
} from "./test-support/lifecycle-test-support.js";

const mocks = getFeishuLifecycleTestMocks();
let lastRuntime = createRuntimeEnv();
let onBotMenu: Awaited<ReturnType<typeof setupFeishuLifecycleHandler>>;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const { cfg: lifecycleConfig, account: lifecycleAccount } = createFeishuLifecycleFixture({
  accountId: "acct-menu",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: { dmPolicy: "open", allowFrom: ["ou_user1"] },
});

function createBotMenuEvent(timestamp: string) {
  return {
    event_key: "quick-actions",
    timestamp,
    operator: { operator_id: { open_id: "ou_user1" } },
  };
}

describe("Feishu bot-menu lifecycle", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    setFeishuLifecycleStateDir("openclaw-feishu-bot-menu");

    mocks.createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    mocks.resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-menu",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    mocks.resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-menu",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      ...mocks,
      replyText: "menu reply once",
    });

    installFeishuLifecycleReplyRuntime({
      ...mocks,
      storePath: "/tmp/feishu-bot-menu-sessions.json",
    });
    onBotMenu = await setupFeishuLifecycleHandler({
      createEventDispatcherMock: mocks.createEventDispatcherMock,
      runtime: lastRuntime,
      cfg: lifecycleConfig,
      account: lifecycleAccount,
      handlerKey: "application.bot.menu_v6",
      missingHandlerMessage: "missing application.bot.menu_v6 handler",
    });
  });

  afterEach(async () => {
    try {
      await stopFeishuLifecycleMonitors();
      restoreFeishuLifecycleStateDir(originalStateDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens one launcher card across duplicate quick-actions replay", async () => {
    await expectFeishuSingleEffectAcrossReplay({
      handler: onBotMenu,
      event: createBotMenuEvent("1700000000000"),
      effectMock: mocks.sendCardFeishuMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(mocks.sendCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acct-menu",
      to: "user:ou_user1",
    });
    expect(mocks.dispatchReplyFromConfigMock).not.toHaveBeenCalled();
    expect(mocks.createFeishuReplyDispatcherMock).not.toHaveBeenCalled();
  });

  it("does not duplicate delivery when launcher fallback hits a post-send failure", async () => {
    mocks.sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));
    mocks.dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "menu reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onBotMenu,
      event: createBotMenuEvent("1700000000002"),
      ...mocks,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
      waitTimeoutMs: 5_000,
    });

    expect(mocks.sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(mocks.createFeishuReplyDispatcherMock.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acct-menu",
      chatId: "p2p:ou_user1",
      replyToMessageId: undefined,
    });
    expect(mocks.dispatchReplyFromConfigMock.mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        AccountId: "acct-menu",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "bot-menu:quick-actions:1700000000002",
      },
    });
    expect(mocks.touchBindingMock).toHaveBeenCalledWith("binding-menu");

    expectFeishuReplyDispatcherSentFinalReplyOnce(mocks);
  });
});
