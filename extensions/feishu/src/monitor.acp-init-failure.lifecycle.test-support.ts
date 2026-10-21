// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuLifecycleFixture,
  createFeishuTextMessageEvent,
  expectFeishuSingleEffectAcrossReplay,
  installFeishuLifecycleReplyRuntime,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
  stopFeishuLifecycleMonitors,
} from "./test-support/lifecycle-test-support.js";

const mocks = getFeishuLifecycleTestMocks();
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const { cfg: lifecycleConfig, account: lifecycleAccount } = createFeishuLifecycleFixture({
  accountId: "acct-acp",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: { groupPolicy: "open", allowFrom: ["ou_sender_1"] },
  accountConfig: {
    groups: {
      oc_group_topic: {
        requireMention: false,
        groupSessionScope: "group_topic",
        replyInThread: "enabled",
      },
    },
  },
  extraConfig: { session: { mainKey: "main", scope: "per-sender" } },
});

describe("Feishu ACP-init failure lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    setFeishuLifecycleStateDir("openclaw-feishu-acp-failure");

    mocks.resolveBoundConversationMock.mockReturnValue(null);
    mocks.resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-acp",
      sessionKey: "agent:main:feishu:group:oc_group_topic",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mocks.resolveConfiguredBindingRouteMock.mockReturnValue({
      // The readiness mock rejects before binding contents can be consumed.
      bindingResolution: {},
      route: {
        agentId: "codex",
        channel: "feishu",
        accountId: "acct-acp",
        sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
      },
    });
    mocks.ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "runtime unavailable",
    });

    mocks.dispatchReplyFromConfigMock.mockResolvedValue({
      queuedFinal: false,
      counts: { final: 0 },
    });
    installFeishuLifecycleReplyRuntime({
      ...mocks,
      storePath: "/tmp/feishu-acp-failure-sessions.json",
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

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const onMessage = await setupFeishuLifecycleHandler({
      createEventDispatcherMock: mocks.createEventDispatcherMock,
      runtime: lastRuntime,
      cfg: lifecycleConfig,
      account: lifecycleAccount,
      handlerKey: "im.message.receive_v1",
      missingHandlerMessage: "missing im.message.receive_v1 handler",
    });
    const event = createFeishuTextMessageEvent({
      messageId: "om_topic_msg_1",
      chatId: "oc_group_topic",
      rootId: "om_topic_root_1",
      threadId: "omt_topic_1",
      text: "hello topic",
    });

    await expectFeishuSingleEffectAcrossReplay({
      handler: onMessage,
      event,
      effectMock: mocks.sendMessageFeishuMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(mocks.resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(mocks.ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acct-acp",
      to: "chat:oc_group_topic",
      replyToMessageId: "om_topic_root_1",
      replyInThread: true,
      text: expect.stringContaining("runtime unavailable"),
    });
    expect(mocks.dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });
});
