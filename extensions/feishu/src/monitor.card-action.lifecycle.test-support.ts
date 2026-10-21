import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createResolvedFeishuLifecycleAccount,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
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
  const openId = "ou_user1";
  const chatId = params.chatId ?? "p2p:ou_user1";
  const chatType = params.chatType ?? "p2p";
  return {
    operator: {
      open_id: openId,
      user_id: "user_1",
      union_id: "union_1",
    },
    token: params.token,
    ...(params.openMessageId ? { open_message_id: params.openMessageId } : {}),
    action: quickAction(chatId, chatType),
    context: {
      open_id: openId,
      user_id: "user_1",
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

describe("Feishu card-action lifecycle", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
    setFeishuLifecycleStateDir("openclaw-feishu-card-action");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    mocks.resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    mocks.resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-card",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "card action reply once",
    });

    installFeishuLifecycleReplyRuntime({
      ...mocks,
      storePath: "/tmp/feishu-card-action-sessions.json",
    });
    onCardAction = await setupFeishuLifecycleHandler({
      createEventDispatcherMock: mocks.createEventDispatcherMock,
      runtime: lastRuntime,
      cfg: lifecycleConfig,
      account: lifecycleAccount,
      handlerKey: "card.action.trigger",
      missingHandlerMessage: "missing card.action.trigger handler",
    });
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

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      throw new Error("post-send failure");
    });

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
