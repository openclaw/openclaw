import {
  createNonExitingRuntimeEnv,
  createRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import * as bot from "./bot.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { FeishuConfigSchema } from "./config-schema.js";
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
  runFeishuLifecycleSequence,
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
  token: string;
  chatId?: string;
  chatType?: "group" | "p2p";
  contextOpenMessageId?: string;
  openMessageId?: string;
}) {
  const identity = { open_id: "ou_user1", user_id: "user_1" };
  const chatId = params.chatId ?? "p2p:ou_user1";
  return {
    operator: { ...identity, union_id: "union_1" },
    token: params.token,
    ...(params.openMessageId ? { open_message_id: params.openMessageId } : {}),
    action: quickAction(chatId, params.chatType ?? "p2p"),
    context: {
      ...identity,
      chat_id: chatId,
      ...(params.contextOpenMessageId ? { open_message_id: params.contextOpenMessageId } : {}),
    },
  };
}

function expectDispatch(params: Record<string, unknown>, context?: Record<string, unknown>) {
  expect(lastRuntime.error).not.toHaveBeenCalled();
  expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
  expect(createFeishuReplyDispatcherMock.mock.calls.at(-1)?.[0]).toMatchObject(params);
  if (context) {
    expect(dispatchReplyFromConfigMock.mock.calls.at(-1)?.[0].ctx).toMatchObject(context);
  }
}

type Fixture = ReturnType<typeof createFeishuLifecycleFixture>;
function startHandler(fixture: Fixture, handlerKey: string, runtime = lastRuntime, once = false) {
  return setupFeishuLifecycleHandler({
    ...fixture,
    createEventDispatcherMock: mocks.createEventDispatcherMock,
    runtime,
    handlerKey,
    missingHandlerMessage: `missing ${handlerKey} handler`,
    once,
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
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
    setFeishuLifecycleStateDir("openclaw-feishu-lifecycle");
  });

  afterEach(async () => {
    try {
      await stopFeishuLifecycleMonitors();
      processedCardActions.clear();
      resolvedCardActionChatTypes.clear();
      restoreFeishuLifecycleStateDir(originalStateDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const fixture = createFeishuLifecycleFixture({
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
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
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
          accountId: "acct-menu",
          appId: "cli_test",
          appSecret: "secret_test",
          channelConfig: { dmPolicy: "open", allowFrom: ["ou_user1"] },
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
    it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
      const handleMessage = vi.spyOn(bot, "handleFeishuMessage").mockResolvedValueOnce(undefined);
      try {
        await onBotMenu({ ...event("1700000000002"), event_key: "custom-key" });
        expect(handleMessage).toHaveBeenCalledOnce();
        expect(handleMessage.mock.calls[0]?.[0].event.message.content).toBe(
          '{"text":"/menu custom-key"}',
        );
        expect(sendCardFeishuMock).not.toHaveBeenCalled();
      } finally {
        handleMessage.mockRestore();
      }
    });
    it("reports a fallback failure without reopening the committed menu event", async () => {
      const handleMessage = vi
        .spyOn(bot, "handleFeishuMessage")
        .mockRejectedValueOnce(new Error("fallback failed"));
      sendCardFeishuMock.mockRejectedValueOnce(new Error("launcher unavailable"));
      try {
        const callback = event("1700000000004");
        await onBotMenu(callback);
        await vi.waitFor(() =>
          expect(lastRuntime.error).toHaveBeenCalledWith(
            "feishu[acct-menu]: error handling bot menu event: Error: fallback failed",
          ),
        );
        await onBotMenu(callback);
        expect(sendCardFeishuMock).toHaveBeenCalledOnce();
        expect(handleMessage).toHaveBeenCalledOnce();
      } finally {
        handleMessage.mockRestore();
      }
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
      expect(createFeishuReplyDispatcherMock.mock.calls[0]?.[0]).toMatchObject({
        accountId: "acct-menu",
        chatId: "p2p:ou_user1",
        replyToMessageId: undefined,
      });
      expect(dispatchReplyFromConfigMock.mock.calls[0]?.[0]).toMatchObject({
        ctx: {
          AccountId: "acct-menu",
          SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
          MessageSid: "bot-menu:quick-actions:1700000000002",
        },
      });
      expect(touchBindingMock).toHaveBeenCalledWith("binding-menu");
      expectFeishuReplyDispatcherSentFinalReplyOnce(mocks);
    });
  });

  it("uses one active Feishu reply path when the same broadcast event reaches two accounts", async () => {
    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());
    const accountConfig = {
      enabled: true,
      connectionMode: "websocket",
      groupPolicy: "open",
      requireMention: false,
      resolveSenderNames: false,
      groups: { oc_broadcast_group: { requireMention: false } },
    } as const;
    const accounts = {
      "account-A": { ...accountConfig, appId: "cli_a", appSecret: "secret_a" }, // pragma: allowlist secret
      "account-B": { ...accountConfig, appId: "cli_b", appSecret: "secret_b" }, // pragma: allowlist secret
    };
    const cfg = {
      broadcast: { oc_broadcast_group: ["susan", "main"] },
      agents: { entries: { main: {}, susan: {} } },
      channels: {
        feishu: {
          enabled: true,
          groupPolicy: "open",
          requireMention: false,
          resolveSenderNames: false,
          accounts,
        },
      },
      messages: { inbound: { debounceMs: 0, byChannel: { feishu: 0 } } },
    } as ClawdbotConfig;
    setRoute("account-A", "agent:main:feishu:group:oc_broadcast_group");
    mockFeishuReplyOnceDispatch({
      ...mocks,
      replyText: "broadcast reply once",
      shouldSendFinalReply: (ctx) =>
        typeof (ctx as { SessionKey?: string } | undefined)?.SessionKey === "string" &&
        (ctx as { SessionKey: string }).SessionKey.includes("agent:main:"),
    });
    const runtimes = [createNonExitingRuntimeEnv(), createNonExitingRuntimeEnv()];
    const handlers = [];
    for (const [index, accountId] of (["account-A", "account-B"] as const).entries()) {
      handlers.push(
        await startHandler(
          {
            cfg,
            account: {
              accountId,
              enabled: true,
              configured: true,
              appId: accounts[accountId].appId,
              appSecret: accounts[accountId].appSecret,
              domain: "feishu",
              config: FeishuConfigSchema.parse(accountConfig),
            },
          },
          "im.message.receive_v1",
          runtimes[index],
          true,
        ),
      );
    }
    const event = createFeishuTextMessageEvent({
      messageId: "om_broadcast_once",
      chatId: "oc_broadcast_group",
      text: "hello broadcast",
    });
    await runFeishuLifecycleSequence(
      handlers.map((handler) => () => handler(event)),
      [
        () => {
          expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
        },
        () => {
          expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
          expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
        },
      ],
    );
    for (const runtime of runtimes) {
      expect(runtime.error).not.toHaveBeenCalled();
    }
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-a",
        chatId: "oc_broadcast_group",
        replyToMessageId: "om_broadcast_once",
      }),
    );
    const sessionKeys = dispatchReplyFromConfigMock.mock.calls.map(
      (call) => call[0].ctx.SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:group:oc_broadcast_group");
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc_broadcast_group");
    expectFeishuReplyDispatcherSentFinalReplyOnce(mocks);
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

      expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
      expectDispatch(
        { accountId: "acct-card", chatId: "p2p:ou_user1", replyToMessageId: undefined },
        {
          AccountId: "acct-card",
          SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
          MessageSid: "card-action-tok-card-once",
        },
      );
      expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

      expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "routes authenticated mention-required groups",
        token: "tok-card-require-mention",
        chatId: "oc_group_require_mention",
        chatType: "group" as const,
        expected: { chatId: "oc_group_require_mention" },
      },
      {
        name: "prefers the original message over a temporary callback id",
        token: "tok-card-original-target",
        openMessageId: "card-action-c-temporary",
        contextOpenMessageId: "om_card_original",
        expected: { replyToMessageId: "om_card_original" },
      },
      {
        name: "plain-sends when only a temporary callback id is available",
        token: "tok-card-temporary-target",
        openMessageId: "card-action-c-temporary",
        expected: { replyToMessageId: undefined },
      },
    ])("$name", async ({ expected, ...params }) => {
      await onCardAction(createCardActionEvent(params));
      expectDispatch(expected, { MessageSid: `card-action-${params.token}` });
    });

    it("routes v2 callbacks with nested operator identity", async () => {
      const chatId = "p2p:ou_user1";

      await onCardAction({
        operator: {
          user_id: {
            open_id: "ou_user1",
            user_id: "user_1",
            union_id: "union_1",
          },
        },
        token: "tok-card-v2-nested-operator",
        action: quickAction(chatId),
        context: {
          open_message_id: "om_card_v2_nested",
          open_chat_id: chatId,
        },
      });

      expectDispatch(
        { accountId: "acct-card", chatId, replyToMessageId: "om_card_v2_nested" },
        {
          AccountId: "acct-card",
          SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
          MessageSid: "card-action-tok-card-v2-nested-operator",
        },
      );
    });

    it("routes SDK-style card callbacks without context as direct callbacks", async () => {
      await onCardAction({
        open_id: "ou_user1",
        user_id: "user_1",
        tenant_key: "tenant_1",
        open_message_id: "om_sdk_card",
        token: "tok-card-sdk-flat",
        action: quickAction(),
      });

      expectDispatch(
        { accountId: "acct-card", chatId: "ou_user1", replyToMessageId: "om_sdk_card" },
        { MessageSid: "card-action-tok-card-sdk-flat" },
      );
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

      expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
      expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
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
