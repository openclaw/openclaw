// Feishu plugin module implements monitor.bot menu.lifecycle support behavior.
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
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  expectFeishuSingleEffectAcrossReplay,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
  stopFeishuLifecycleMonitors,
} from "./test-support/lifecycle-test-support.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  resolveAgentRouteMock,
  resolveRuntimeConversationBindingRouteMock,
  sendCardFeishuMock,
} = getFeishuLifecycleTestMocks();
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const { cfg: lifecycleConfig, account: lifecycleAccount } = createFeishuLifecycleFixture({
  accountId: "acct-menu",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
  accountConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
});

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
    },
  };
}

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    onRegister: () => {},
    runtime: lastRuntime,
    cfg: lifecycleConfig,
    account: lifecycleAccount,
    handlerKey: "application.bot.menu_v6",
    missingHandlerMessage: "missing application.bot.menu_v6 handler",
  });
}

describe("Feishu bot-menu lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    setFeishuLifecycleStateDir("openclaw-feishu-bot-menu");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveRuntimeConversationBindingRouteMock.mockReturnValue({
      bindingRecord: {
        bindingId: "binding-menu",
        targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        targetKind: "session",
        conversation: { channel: "feishu", accountId: "acct-menu", conversationId: "ou_user1" },
        status: "active",
        boundAt: 0,
      },
      boundSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
      boundAgentId: "bound-agent",
      route: {
        agentId: "bound-agent",
        channel: "feishu",
        accountId: "acct-menu",
        sessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        mainSessionKey: "agent:bound-agent:main",
        lastRoutePolicy: "session",
        matchedBy: "binding.channel",
      },
    });

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-menu",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "menu reply once",
    });

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      dispatchReplyFromConfigMock,
      storePath: "/tmp/feishu-bot-menu-sessions.json",
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
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000000",
    });

    await expectFeishuSingleEffectAcrossReplay({
      handler: onBotMenu,
      event,
      effectMock: sendCardFeishuMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        to: "user:ou_user1",
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
    expect(createFeishuReplyDispatcherMock).not.toHaveBeenCalled();
  });

  it("falls back once to the legacy routed reply path when launcher rendering fails", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000001",
    });
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onBotMenu,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
      waitTimeoutMs: 5_000,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        agentId: "bound-agent",
        chatId: "p2p:ou_user1",
        replyToMessageId: undefined,
      }),
    );
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          AccountId: "acct-menu",
          SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
          MessageSid: "bot-menu:quick-actions:1700000000001",
        }),
      }),
    );
    expect(resolveRuntimeConversationBindingRouteMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        conversation: { channel: "feishu", accountId: "acct-menu", conversationId: "ou_user1" },
      }),
    );

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  it("does not duplicate delivery when launcher fallback hits a post-send failure", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000002",
    });
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));
    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "menu reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onBotMenu,
      event,
      dispatchReplyFromConfigMock,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
      waitTimeoutMs: 5_000,
    });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
