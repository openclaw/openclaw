import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockGetMessageFeishu,
  mockDispatchReply,
  mockResolveAgentRoute,
  mockCreateFeishuReplyDispatcher,
} = vi.hoisted(() => ({
  mockGetMessageFeishu: vi.fn<typeof import("./send.js").getMessageFeishu>(),
  mockDispatchReply: vi
    .fn<PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]>()
    .mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } }),
  mockResolveAgentRoute: vi.fn<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>(() =>
    createFeishuTestRoute(),
  ),
  mockCreateFeishuReplyDispatcher: vi.fn(
    (
      _params: Parameters<typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher>[0],
    ) => ({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    }),
  ),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: mockGetMessageFeishu,
  listFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  sendMessageFeishu: vi.fn(),
}));
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));
vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
}));
vi.mock("./bot-group-name.js", () => ({ resolveGroupName: vi.fn(async () => undefined) }));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: ({
      route,
    }: Parameters<typeof actual.resolveConfiguredBindingRoute>[0]) => ({
      route,
      bindingResolution: null,
    }),
    resolveRuntimeConversationBindingRoute: ({
      route,
    }: Parameters<typeof actual.resolveRuntimeConversationBindingRoute>[0]) => ({
      route,
      bindingRecord: null,
    }),
  };
});

afterAll(() => vi.doUnmock("./bot-group-name.js"));

let currentRuntimeConfig = {} as ClawdbotConfig;

async function dispatchMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
}) {
  currentRuntimeConfig = params.cfg;
  await handleFeishuMessage({ ...params, runtime: createRuntimeEnv() });
}

describe("Feishu bot-owned thread mentions", () => {
  const root = {
    messageId: "om_bot_root",
    chatId: "oc-group",
    senderId: "cli_test",
    senderType: "app",
    content: "topic starter",
    contentType: "text",
  };
  const config = (overrides: Parameters<typeof createFeishuTestConfig>[0]) =>
    createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "test-secret",
      requireMention: true,
      requireMentionInBotThreads: false,
      resolveSenderNames: false,
      ...overrides,
    });
  const event = (
    messageId: string,
    message: Partial<FeishuMessageEvent["message"]>,
    chatType: FeishuMessageEvent["message"]["chat_type"] = "group",
  ) => createFeishuTestEvent({ messageId, chatId: "oc-group", chatType, message });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    setFeishuRuntime(
      createPluginRuntimeMock({
        config: { current: () => currentRuntimeConfig },
        channel: {
          inbound: { buildContext: buildChannelInboundEventContext },
          reply: { dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply },
          routing: { resolveAgentRoute: mockResolveAgentRoute },
        },
      }),
    );
  });

  it.each([
    { name: "this app", expected: true },
    {
      name: "this bot's typed open ID",
      root: { senderId: "ou-bot", senderOpenId: "ou-bot" },
      expected: true,
    },
    { name: "another app", root: { senderId: "cli_other" }, expected: false },
    { name: "a user", root: { senderType: "user" }, expected: false },
    { name: "untyped open ID", root: { senderId: "ou-bot" }, expected: false },
    { name: "unreadable root", lookupFailed: true, expected: false },
    { name: "another chat", root: { chatId: "oc-other" }, expected: false },
    { name: "another message", root: { messageId: "om_other" }, expected: false },
    { name: "inline quote", inlineQuote: true, expected: false },
    { name: "omitted setting", omitted: true, expected: false },
  ])("admits unmentioned topic replies only for a verified bot root: $name", async (testCase) => {
    if (testCase.lookupFailed) {
      mockGetMessageFeishu.mockRejectedValueOnce(new Error("root unavailable"));
    } else {
      mockGetMessageFeishu.mockResolvedValue({
        ...root,
        ...testCase.root,
        threadId: "omt_bot_topic",
      });
    }
    await dispatchMessage({
      cfg: config({
        requireMentionInBotThreads: testCase.omitted ? undefined : false,
        groups: { "oc-group": { groupSessionScope: "group_topic" } },
      }),
      botOpenId: "ou-bot",
      event: event(`msg-owned-thread-${testCase.name}`, {
        root_id: "om_bot_root",
        parent_id: "om_bot_root",
        ...(testCase.inlineQuote ? {} : { thread_id: "omt_bot_topic" }),
      }),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(testCase.expected ? 1 : 0);
    expect(mockGetMessageFeishu).toHaveBeenCalledTimes(
      testCase.omitted || testCase.inlineQuote ? 0 : 1,
    );
    if (testCase.expected) {
      expect(mockDispatchReply.mock.calls[0]?.[0].ctx).toMatchObject({
        GroupRequireMention: false,
        ReplyToId: "om_bot_root",
        ReplyToBody: "topic starter",
        ThreadStarterBody: "topic starter",
        ThreadLabel: "Feishu thread in oc-group",
      });
    }
  });

  it.each([
    { name: "account disables inherited requirement", accountSetting: false, expected: true },
    {
      name: "group disables account requirement",
      accountSetting: true,
      groupSetting: false,
      expected: true,
    },
    {
      name: "group requires mention despite parent allowing all messages",
      accountSetting: false,
      groupSetting: true,
      expected: false,
    },
    {
      name: "explicit mention satisfies strict group setting",
      accountSetting: false,
      groupSetting: true,
      mentioned: true,
      expected: true,
    },
  ])("uses account and group bot-thread mention precedence: $name", async (testCase) => {
    mockGetMessageFeishu.mockResolvedValue(root);
    await dispatchMessage({
      cfg: config({
        requireMention: testCase.groupSetting !== true,
        requireMentionInBotThreads: true,
        accounts: {
          default: {
            requireMentionInBotThreads: testCase.accountSetting,
            groups: { "oc-group": { requireMentionInBotThreads: testCase.groupSetting } },
          },
        },
      }),
      botOpenId: "ou-bot",
      event: event(
        `msg-owned-scope-${testCase.name}`,
        {
          root_id: "om_bot_root",
          ...(testCase.mentioned
            ? { mentions: [{ key: "@_bot", id: { open_id: "ou-bot" }, name: "Bot" }] }
            : {}),
        },
        "topic_group",
      ),
    });
    expect(mockDispatchReply).toHaveBeenCalledTimes(testCase.expected ? 1 : 0);
  });

  it.each([
    { name: "group admission", update: { groupPolicy: "disabled" as const }, expected: false },
    { name: "sender admission", update: { groupSenderAllowFrom: ["ou-other"] }, expected: false },
    { name: "mention requirement", update: { requireMentionInBotThreads: true }, expected: false },
    { name: "bot app", update: { appId: "cli_changed" }, expected: false },
    { name: "unrelated config", update: { textChunkLimit: 2000 }, expected: true },
  ])(
    "rechecks current $name after fetching bot-owned thread roots",
    async ({ name, update, expected }) => {
      const lookupStarted = createDeferred<void>();
      const releaseLookup = createDeferred<void>();
      mockGetMessageFeishu.mockImplementationOnce(async () => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return root;
      });
      const cfg = config({ groupPolicy: "open" });
      const pending = dispatchMessage({
        cfg,
        event: event(`msg-owned-current-${name}`, {
          root_id: "om_bot_root",
          thread_id: "omt_bot_topic",
        }),
      });
      await lookupStarted.promise;
      currentRuntimeConfig = createFeishuTestConfig({ ...cfg.channels?.feishu, ...update });
      releaseLookup.resolve();
      await pending;

      expect(mockDispatchReply).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (!expected) {
        expect(mockResolveAgentRoute).not.toHaveBeenCalled();
      }
    },
  );
});

describe("Feishu topic session keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    setFeishuRuntime(
      createPluginRuntimeMock({
        config: { current: () => currentRuntimeConfig },
        channel: {
          inbound: { buildContext: buildChannelInboundEventContext },
          reply: { dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply },
          routing: { resolveAgentRoute: mockResolveAgentRoute },
        },
      }),
    );
  });

  const topicCfg = () =>
    createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "test-secret",
      groupPolicy: "open",
      requireMention: false,
      groups: {
        "oc-group": { groupSessionScope: "group_topic", replyInThread: "enabled" },
      },
    });

  const routedPeerIds = () =>
    mockResolveAgentRoute.mock.calls.map(([params]) => {
      const peer = (params as unknown as { peer?: { id?: string } } | undefined)?.peer;
      return peer?.id;
    });

  it("keys every message of a topic to the topic id, including quote replies", async () => {
    // Feishu reports thread_id on every message of a topic, while a quote reply's root_id points
    // at the quoted message. Keying on root_id first split one topic into two sessions.
    const cfg = topicCfg();
    // The quoted-message lookup must not be able to move the session.
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_mid_topic_message",
      chatId: "oc-group",
      chatType: "topic_group",
      content: "quoted",
      contentType: "text",
      threadId: "omt_some_other_topic",
    });

    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "om_topic_starter_message",
        senderOpenId: "ou-topic-user",
        chatId: "oc-group",
        chatType: "group",
        text: "topic starter",
        message: { thread_id: "omt_topic_quote" },
      }),
    });
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "om_topic_quoted_reply",
        senderOpenId: "ou-topic-user",
        chatId: "oc-group",
        chatType: "group",
        text: "quote reply inside the same topic",
        message: { root_id: "om_mid_topic_message", thread_id: "omt_topic_quote" },
      }),
    });

    expect(routedPeerIds()).toEqual([
      "oc-group:topic:omt_topic_quote",
      "oc-group:topic:omt_topic_quote",
    ]);
  });

  it("keeps the topic id as the session key for a topic starter", async () => {
    // Existing topic sessions are stored under this key, so it must stay the topic id.
    await dispatchMessage({
      cfg: topicCfg(),
      event: createFeishuTestEvent({
        messageId: "om_fallback_topic_starter",
        senderOpenId: "ou-topic-user",
        chatId: "oc-group",
        chatType: "group",
        text: "topic starter",
        message: { thread_id: "omt_topic_fallback" },
      }),
    });

    expect(routedPeerIds()).toEqual(["oc-group:topic:omt_topic_fallback"]);
  });

  it("keeps a message that precedes its topic on the message key", async () => {
    // Only when the bot's own threaded reply creates the topic does the first message arrive
    // without a topic id: it keeps its message key, and later topic messages use the topic id.
    const cfg = topicCfg();
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-pre-topic",
        senderOpenId: "ou-topic-init",
        chatId: "oc-group",
        chatType: "group",
        text: "message that creates the thread",
      }),
    });
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-in-created-topic",
        senderOpenId: "ou-topic-init",
        chatId: "oc-group",
        chatType: "group",
        text: "reply inside the created thread",
        message: { root_id: "msg-pre-topic", thread_id: "omt_topic_from_reply" },
      }),
    });

    expect(routedPeerIds()).toEqual([
      "oc-group:topic:msg-pre-topic",
      "oc-group:topic:omt_topic_from_reply",
    ]);
  });

  it("keeps one topic session when every topic message carries the topic id", async () => {
    const cfg = topicCfg();
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-topic-first",
        senderOpenId: "ou-topic-init",
        chatId: "oc-group",
        chatType: "group",
        text: "topic starter",
        message: { thread_id: "omt_topic_created" },
      }),
    });
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-topic-second",
        senderOpenId: "ou-topic-init",
        chatId: "oc-group",
        chatType: "group",
        text: "follow up in same topic",
        message: { root_id: "msg-topic-first", thread_id: "omt_topic_created" },
      }),
    });

    expect(routedPeerIds()).toEqual([
      "oc-group:topic:omt_topic_created",
      "oc-group:topic:omt_topic_created",
    ]);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyToMessageId: "msg-topic-first",
        rootId: "msg-topic-first",
        typingTargetMessageId: "msg-topic-second",
      }),
    );
  });
});
