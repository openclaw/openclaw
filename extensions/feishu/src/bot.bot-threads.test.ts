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

const { mockGetMessageFeishu, mockDispatchReply, mockResolveAgentRoute } = vi.hoisted(() => ({
  mockGetMessageFeishu: vi.fn<typeof import("./send.js").getMessageFeishu>(),
  mockDispatchReply: vi
    .fn<PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]>()
    .mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } }),
  mockResolveAgentRoute: vi.fn<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>(() =>
    createFeishuTestRoute(),
  ),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: mockGetMessageFeishu,
  listFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  sendMessageFeishu: vi.fn(),
}));
vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: vi.fn(() => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
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
    { name: "this app", senderId: "cli_test", senderType: "app", expected: true },
    {
      name: "this bot's typed open ID",
      senderId: "ou-bot",
      senderOpenId: "ou-bot",
      senderType: "app",
      expected: true,
    },
    { name: "another app", senderId: "cli_other", senderType: "app", expected: false },
    { name: "a user", senderId: "cli_test", senderType: "user", expected: false },
    { name: "untyped open ID", senderId: "ou-bot", senderType: "app", expected: false },
    { name: "missing root", missingRoot: true, expected: false },
    { name: "unreadable root", lookupFailed: true, expected: false },
    {
      name: "another chat",
      senderId: "cli_test",
      senderType: "app",
      wrongChat: true,
      expected: false,
    },
    {
      name: "another message",
      senderId: "cli_test",
      senderType: "app",
      wrongRoot: true,
      expected: false,
    },
    {
      name: "inline quote",
      senderId: "cli_test",
      senderType: "app",
      inlineQuote: true,
      expected: false,
    },
    {
      name: "omitted setting",
      senderId: "cli_test",
      senderType: "app",
      omitted: true,
      expected: false,
    },
  ])("admits unmentioned topic replies only for a verified bot root: $name", async (testCase) => {
    const root = {
      messageId: testCase.wrongRoot ? "om_other" : "om_bot_root",
      chatId: testCase.wrongChat ? "oc-other" : "oc-group",
      senderId: testCase.senderId,
      senderOpenId: testCase.senderOpenId,
      senderType: testCase.senderType,
      content: "topic starter",
      contentType: "text",
      threadId: "omt_bot_topic",
    };
    if (testCase.lookupFailed) {
      mockGetMessageFeishu.mockRejectedValueOnce(new Error("root unavailable"));
    } else {
      mockGetMessageFeishu.mockResolvedValue(testCase.missingRoot ? null : root);
    }
    await dispatchMessage({
      cfg: createFeishuTestConfig({
        appId: "cli_test",
        appSecret: "test-secret",
        requireMention: true,
        requireMentionInBotThreads: testCase.omitted ? undefined : false,
        resolveSenderNames: false,
        groups: { "oc-group": { groupSessionScope: "group_topic" } },
      }),
      botOpenId: "ou-bot",
      event: createFeishuTestEvent({
        messageId: `msg-owned-thread-${testCase.name}`,
        chatId: "oc-group",
        chatType: "group",
        message: {
          root_id: "om_bot_root",
          parent_id: "om_bot_root",
          ...(testCase.inlineQuote ? {} : { thread_id: "omt_bot_topic" }),
        },
      }),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(testCase.expected ? 1 : 0);
    expect(mockGetMessageFeishu).toHaveBeenCalledTimes(
      testCase.omitted || testCase.inlineQuote ? 0 : 1,
    );
    if (testCase.expected) {
      expect(mockDispatchReply.mock.calls[0]?.[0].ctx).toEqual(
        expect.objectContaining({
          GroupRequireMention: false,
          ReplyToId: "om_bot_root",
          ReplyToBody: "topic starter",
          ThreadStarterBody: "topic starter",
          ThreadLabel: "Feishu thread in oc-group",
        }),
      );
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
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_bot_root",
      chatId: "oc-group",
      senderId: "cli_test",
      senderType: "app",
      content: "topic starter",
      contentType: "text",
    });
    await dispatchMessage({
      cfg: createFeishuTestConfig({
        appId: "cli_test",
        appSecret: "test-secret",
        requireMention: testCase.groupSetting !== true,
        requireMentionInBotThreads: true,
        resolveSenderNames: false,
        accounts: {
          default: {
            requireMentionInBotThreads: testCase.accountSetting,
            groups: { "oc-group": { requireMentionInBotThreads: testCase.groupSetting } },
          },
        },
      }),
      botOpenId: "ou-bot",
      event: createFeishuTestEvent({
        messageId: `msg-owned-scope-${testCase.name}`,
        chatId: "oc-group",
        chatType: "topic_group",
        message: {
          root_id: "om_bot_root",
          ...(testCase.mentioned
            ? { mentions: [{ key: "@_bot", id: { open_id: "ou-bot" }, name: "Bot" }] }
            : {}),
        },
      }),
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
        return {
          messageId: "om_bot_root",
          chatId: "oc-group",
          senderId: "cli_test",
          senderType: "app",
          content: "topic starter",
          contentType: "text",
        };
      });
      const cfg = createFeishuTestConfig({
        appId: "cli_test",
        appSecret: "test-secret",
        groupPolicy: "open",
        requireMention: true,
        requireMentionInBotThreads: false,
        resolveSenderNames: false,
      });
      const pending = dispatchMessage({
        cfg,
        event: createFeishuTestEvent({
          messageId: `msg-owned-current-${name}`,
          chatId: "oc-group",
          chatType: "group",
          message: { root_id: "om_bot_root", thread_id: "omt_bot_topic" },
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
