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

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
    groupPolicy: "open",
    groups: {
      oc_group_require_mention: { requireMention: true },
    },
  },
  accountConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
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

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    runtime: lastRuntime,
    cfg: lifecycleConfig,
    account: lifecycleAccount,
    handlerKey: "card.action.trigger",
    missingHandlerMessage: "missing card.action.trigger handler",
  });
}

function latestReplyDispatcherParams() {
  const call = createFeishuReplyDispatcherMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected Feishu reply dispatcher call");
  }
  return call[0] as {
    accountId?: string;
    chatId?: string;
    replyToMessageId?: string;
  };
}

function latestFinalizedContext() {
  const call = dispatchReplyFromConfigMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected finalized inbound context call");
  }
  return call[0].ctx as {
    AccountId?: string;
    SessionKey?: string;
    MessageSid?: string;
  };
}

function expectOneDispatch() {
  expect(lastRuntime.error).not.toHaveBeenCalled();
  expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
}

describe("Feishu card-action lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    lastRuntime = createRuntimeEnv();
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
    setFeishuLifecycleStateDir("openclaw-feishu-card-action");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
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
      resolveAgentRouteMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-card-action-sessions.json",
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
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({ token: "tok-card-once" });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onCardAction,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
    });

    expectOneDispatch();
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(latestReplyDispatcherParams()).toMatchObject({
      accountId: "acct-card",
      chatId: "p2p:ou_user1",
    });
    expect(latestReplyDispatcherParams().replyToMessageId).toBeUndefined();
    expect(latestFinalizedContext()).toMatchObject({
      AccountId: "acct-card",
      SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
      MessageSid: "card-action-tok-card-once",
    });
    expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("routes authenticated group callbacks when the group requires a mention", async () => {
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction(
      createCardActionEvent({
        token: "tok-card-require-mention",
        chatId: "oc_group_require_mention",
        chatType: "group",
      }),
    );

    expectOneDispatch();
    expect(latestReplyDispatcherParams().chatId).toBe("oc_group_require_mention");
    expect(latestFinalizedContext().MessageSid).toBe("card-action-tok-card-require-mention");
  });

  it("prefers the original context message id over a temporary callback id", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-original-target",
      openMessageId: "card-action-c-temporary",
      contextOpenMessageId: "om_card_original",
    });

    await onCardAction(event);

    expectOneDispatch();
    expect(latestReplyDispatcherParams().replyToMessageId).toBe("om_card_original");
  });

  it("routes v2 callbacks with nested operator identity", async () => {
    const onCardAction = await setupLifecycleMonitor();
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

    expectOneDispatch();
    expect(latestReplyDispatcherParams()).toMatchObject({
      accountId: "acct-card",
      chatId,
      replyToMessageId: "om_card_v2_nested",
    });
    expect(latestFinalizedContext()).toMatchObject({
      AccountId: "acct-card",
      SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
      MessageSid: "card-action-tok-card-v2-nested-operator",
    });
  });

  it("routes SDK-style card callbacks without context as direct callbacks", async () => {
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction({
      open_id: "ou_user1",
      user_id: "user_1",
      tenant_key: "tenant_1",
      open_message_id: "om_sdk_card",
      token: "tok-card-sdk-flat",
      action: quickAction(),
    });

    expectOneDispatch();
    expect(latestReplyDispatcherParams()).toMatchObject({
      accountId: "acct-card",
      chatId: "ou_user1",
      replyToMessageId: "om_sdk_card",
    });
    expect(latestFinalizedContext().MessageSid).toBe("card-action-tok-card-sdk-flat");
  });

  it("plain-sends card action replies when only a temporary callback id is available", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-temporary-target",
      openMessageId: "card-action-c-temporary",
    });

    await onCardAction(event);

    expectOneDispatch();
    expect(latestReplyDispatcherParams().replyToMessageId).toBeUndefined();
  });

  it("does not duplicate delivery when retrying after a post-send failure", async () => {
    const onCardAction = await setupLifecycleMonitor();
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
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction(createCardActionEvent({ token: "" }));

    expect(lastRuntime?.error).toHaveBeenCalledWith(
      "feishu[acct-card]: ignoring malformed card action payload",
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });
});
