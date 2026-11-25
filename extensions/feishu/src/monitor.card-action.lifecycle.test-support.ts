import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import { cardActionReplayGuard, resolvedCardActionChatTypes } from "./card-action-state.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleFixture,
  createFeishuLifecycleReplyDispatcher,
  createFeishuTextMessageEvent,
  createResolvedFeishuLifecycleAccount,
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

const mocks = getFeishuLifecycleTestMocks();
const {
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  touchBindingMock,
} = mocks;
let lastRuntime = createRuntimeEnv();
let onCardAction: Awaited<ReturnType<typeof setupFeishuLifecycleHandler>>;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const credentials = { accountId: "acct-card", appId: "cli_test", appSecret: "secret_test" };
const directConfig = { dmPolicy: "open", allowFrom: ["ou_user1"] };
const identity = { open_id: "ou_user1", user_id: "user_1", union_id: "union_1" };
const lifecycleConfig = createFeishuLifecycleConfig({
  ...credentials,
  channelConfig: {
    ...directConfig,
    groupPolicy: "open",
    groups: {
      oc_group_require_mention: { requireMention: true },
    },
  },
  accountConfig: directConfig,
});
const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  ...credentials,
  config: directConfig,
});

function quickAction(chatId?: string, chatType: "group" | "p2p" = "p2p") {
  return {
    tag: "button",
    value: createFeishuCardInteractionEnvelope({
      k: "quick",
      a: "feishu.quick_actions.help",
      q: "/help",
      c: { u: "ou_user1", h: chatId, t: chatType, e: Date.now() + 60_000 },
    }),
  };
}

function createCardActionEvent(params: {
  token?: string;
  chatId?: string;
  chatType?: "group" | "p2p";
  contextOpenMessageId?: string;
  openMessageId?: string;
}) {
  const chatId = params.chatId ?? "p2p:ou_user1";
  return {
    operator: identity,
    token: params.token ?? "tok-card",
    ...(params.openMessageId ? { open_message_id: params.openMessageId } : {}),
    action: quickAction(chatId, params.chatType ?? "p2p"),
    context: {
      open_id: identity.open_id,
      user_id: identity.user_id,
      chat_id: chatId,
      ...(params.contextOpenMessageId ? { open_message_id: params.contextOpenMessageId } : {}),
    },
  };
}

function expectDispatch(params: Record<string, unknown>, context?: Record<string, unknown>) {
  expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
  expect(createFeishuReplyDispatcherMock.mock.calls.at(-1)?.[0]).toMatchObject(params);
  if (context) {
    expect(dispatchReplyFromConfigMock.mock.calls.at(-1)?.[0].ctx).toMatchObject(context);
  }
}
function expectDirectDispatch(accountId: string, messageId: string, replyToMessageId?: string) {
  expectDispatch(
    { accountId, chatId: "p2p:ou_user1", replyToMessageId },
    {
      AccountId: accountId,
      SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
      MessageSid: messageId,
    },
  );
}

type Fixture = ReturnType<typeof createFeishuLifecycleFixture>;
function startHandler(fixture: Fixture, handlerKey: string) {
  return setupFeishuLifecycleHandler({
    ...fixture,
    createEventDispatcherMock: mocks.createEventDispatcherMock,
    runtime: lastRuntime,
    handlerKey,
    missingHandlerMessage: `missing ${handlerKey} handler`,
  });
}
function setRoute(accountId: string, sessionKey: string, bindingId?: string) {
  mocks.resolveAgentRouteMock.mockReturnValue({
    agentId: "main",
    channel: "feishu",
    accountId,
    sessionKey,
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  });
  mocks.resolveBoundConversationMock.mockImplementation(() =>
    bindingId
      ? {
          bindingId,
          targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        }
      : null,
  );
  installFeishuLifecycleReplyRuntime({
    ...mocks,
    storePath: `/tmp/feishu-${accountId}-sessions.json`,
  });
}
function failAfterReply(text: string) {
  dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
    await dispatcher.sendFinalReply({ text });
    throw new Error("post-send failure");
  });
}

describe("Feishu event reply lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    cardActionReplayGuard.clearMemory();
    resolvedCardActionChatTypes.clear();
    setFeishuLifecycleStateDir("openclaw-feishu-lifecycle");
  });

  afterEach(async () => {
    try {
      await stopFeishuLifecycleMonitors();
      cardActionReplayGuard.clearMemory();
      resolvedCardActionChatTypes.clear();
      restoreFeishuLifecycleStateDir(originalStateDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const fixture = createFeishuLifecycleFixture({
      ...credentials,
      accountId: "acct-acp",
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
    setRoute("acct-acp", "agent:main:feishu:group:oc_group_topic");
    mocks.resolveConfiguredBindingRouteMock.mockReturnValue({
      // Readiness rejects before binding contents can be consumed.
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
    dispatchReplyFromConfigMock.mockResolvedValue({ queuedFinal: false, counts: { final: 0 } });
    await expectFeishuSingleEffectAcrossReplay({
      handler: await startHandler(fixture, "im.message.receive_v1"),
      event: createFeishuTextMessageEvent({
        messageId: "om_topic_msg_1",
        chatId: "oc_group_topic",
        rootId: "om_topic_root_1",
        threadId: "omt_topic_1",
        text: "hello topic",
      }),
      effectMock: sendMessageFeishuMock,
    });
    expect(lastRuntime.error).not.toHaveBeenCalled();
    expect(mocks.resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(mocks.ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      accountId: "acct-acp",
      to: "chat:oc_group_topic",
      replyToMessageId: "om_topic_root_1",
      replyInThread: true,
      text: expect.stringContaining("runtime unavailable"),
    });
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });

  describe("bot menu", () => {
    let onBotMenu: Awaited<ReturnType<typeof startHandler>>;
    const event = (timestamp: string) => ({
      event_key: "quick-actions",
      timestamp,
      operator: { operator_id: { open_id: "ou_user1" } },
    });
    beforeEach(async () => {
      createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());
      setRoute("acct-menu", "agent:main:feishu:direct:ou_user1", "binding-menu");
      mockFeishuReplyOnceDispatch({ ...mocks, replyText: "menu reply once" });
      onBotMenu = await startHandler(
        createFeishuLifecycleFixture({
          ...credentials,
          accountId: "acct-menu",
          channelConfig: directConfig,
        }),
        "application.bot.menu_v6",
      );
    });
    it("opens one launcher card across duplicate quick-actions replay", async () => {
      await expectFeishuSingleEffectAcrossReplay({
        handler: onBotMenu,
        event: event("1700000000000"),
        effectMock: sendCardFeishuMock,
      });
      expect(lastRuntime.error).not.toHaveBeenCalled();
      expect(sendCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
        accountId: "acct-menu",
        to: "user:ou_user1",
      });
      expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
      expect(createFeishuReplyDispatcherMock).not.toHaveBeenCalled();
    });
    it("does not duplicate delivery when launcher fallback hits a post-send failure", async () => {
      sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));
      failAfterReply("menu reply once");
      await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
        ...mocks,
        handler: onBotMenu,
        event: event("1700000000002"),
        runtimeErrorMock: lastRuntime.error as ReturnType<typeof vi.fn>,
        waitTimeoutMs: 5_000,
      });
      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expectDirectDispatch("acct-menu", "bot-menu:quick-actions:1700000000002");
      expect(touchBindingMock).toHaveBeenCalledWith("binding-menu");
      expectFeishuReplyDispatcherSentFinalReplyOnce(mocks);
    });
  });

  describe("card action", () => {
    beforeEach(async () => {
      createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());
      setRoute("acct-card", "agent:main:feishu:direct:ou_user1", "binding-card");
      mockFeishuReplyOnceDispatch({ ...mocks, replyText: "card action reply once" });
      onCardAction = await startHandler(
        { cfg: lifecycleConfig, account: lifecycleAccount },
        "card.action.trigger",
      );
    });

    it("routes one reply across duplicate callback delivery", async () => {
      const event = createCardActionEvent({ token: "tok-card-once" });

      await expectFeishuReplyPipelineDedupedAcrossReplay({
        handler: onCardAction,
        event,
        dispatchReplyFromConfigMock,
        createFeishuReplyDispatcherMock,
      });

      expectDirectDispatch("acct-card", "card-action-tok-card-once");
      expect(lastRuntime.error).not.toHaveBeenCalled();
      expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

      expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "routes authenticated mention-required groups",
        event: () =>
          createCardActionEvent({ chatId: "oc_group_require_mention", chatType: "group" }),
        expected: { chatId: "oc_group_require_mention" },
      },
      {
        name: "prefers the original message over a temporary callback id",
        event: () =>
          createCardActionEvent({
            openMessageId: "card-action-c-temporary",
            contextOpenMessageId: "om_card_original",
          }),
        expected: { replyToMessageId: "om_card_original" },
      },
      {
        name: "plain-sends when only a temporary callback id is available",
        event: () => createCardActionEvent({ openMessageId: "card-action-c-temporary" }),
        expected: { replyToMessageId: undefined },
      },
      {
        name: "routes v2 callbacks with nested operator identity",
        event: () => ({
          operator: { user_id: identity },
          token: "tok-card",
          action: quickAction("p2p:ou_user1"),
          context: { open_message_id: "om_card_v2_nested", open_chat_id: "p2p:ou_user1" },
        }),
        expected: {
          accountId: "acct-card",
          chatId: "p2p:ou_user1",
          replyToMessageId: "om_card_v2_nested",
        },
        context: { AccountId: "acct-card", SessionKey: "agent:bound-agent:feishu:direct:ou_user1" },
      },
      {
        name: "routes SDK-style card callbacks without context as direct callbacks",
        event: () => ({
          open_id: "ou_user1",
          user_id: "user_1",
          tenant_key: "tenant_1",
          open_message_id: "om_sdk_card",
          token: "tok-card",
          action: quickAction(),
        }),
        expected: { accountId: "acct-card", chatId: "ou_user1", replyToMessageId: "om_sdk_card" },
      },
    ])("$name", async (row) => {
      await onCardAction(row.event());
      expectDispatch(row.expected, {
        MessageSid: "card-action-tok-card",
        ...("context" in row ? row.context : {}),
      });
      expect(lastRuntime.error).not.toHaveBeenCalled();
    });

    it("does not duplicate delivery when retrying after a post-send failure", async () => {
      const event = createCardActionEvent({ token: "tok-card-retry" });

      failAfterReply("card action reply once");

      await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
        handler: onCardAction,
        event,
        dispatchReplyFromConfigMock,
        runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
      });

      expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
    });

    it("drops malformed card-action events with empty tokens before handler dispatch", async () => {
      await onCardAction(createCardActionEvent({ token: "" }));

      expect(lastRuntime?.error).toHaveBeenCalledWith(
        "feishu[acct-card]: ignoring malformed card action payload",
      );
      expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
    });
  });
});
