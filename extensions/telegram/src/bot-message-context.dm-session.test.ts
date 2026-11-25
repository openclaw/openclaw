import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  testing as bindingTesting,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  addTestHook,
  createPluginRecord,
  getActivePluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import {
  deleteSessionEntry,
  getSessionEntry,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  chat,
  commandMessage,
  createBot,
  deliverTelegramUpdate,
  groupChat,
  groupCommand,
  from,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";

let cfg: OpenClawConfig;
let storePath: string;
let updateId = 6000;

beforeEach(() => {
  const storeDir = harness.state.path("telegram-context-session");
  mkdirSync(storeDir);
  storePath = path.join(storeDir, "sessions.json");
  cfg = {
    session: { store: storePath },
    commands: { native: false },
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        autoTopicLabel: false,
        streaming: { mode: "off" },
        groups: { "*": { requireMention: false } },
      },
    },
  };
  bindingTesting.resetSessionBindingAdaptersForTests();
  resetTelegramTopicNameCacheForTest();
});

afterEach(() => {
  bindingTesting.resetSessionBindingAdaptersForTests();
  resetTelegramTopicNameCacheForTest();
  resetGlobalHookRunner();
});

function bind(
  conversationId: string,
  targetSessionKey: string,
  metadata?: SessionBindingRecord["metadata"],
) {
  const record: SessionBindingRecord = {
    bindingId: "context-binding",
    targetSessionKey,
    targetKind: "session",
    conversation: { channel: "telegram", accountId: "default", conversationId },
    status: "active",
    boundAt: 1,
    metadata,
  };
  registerSessionBindingAdapter({
    channel: "telegram",
    accountId: "default",
    listBySession: () => [record],
    resolveByConversation: (conversation) =>
      conversation.conversationId === conversationId ? record : null,
  });
}

async function receive(bot: Bot, message: NonNullable<Update["message"]>) {
  await deliverTelegramUpdate(bot, {
    update_id: ++updateId,
    message: { ...message, entities: message.text?.startsWith("@") ? message.entities : [] },
  });
}

const entry = (sessionKey: string, agentId?: string) =>
  getSessionEntry({ storePath, sessionKey, agentId });
const deliveryContext = (to: string, threadId?: string) => ({
  channel: "telegram",
  to,
  ...(threadId === undefined ? {} : { threadId }),
});
function expectDelivery(sessionKey: string, context: Record<string, unknown>) {
  expect(entry(sessionKey)?.delivery).toMatchObject({ kind: "external", context });
}
const privateTopicKey = "agent:main:main:thread:42001:77";
function serviceMessage(fields: Partial<NonNullable<Update["message"]>>) {
  return { message_id: ++updateId, date: 1736380700, chat, from, ...fields };
}
function topicReply(name: string, messageId: number, fromBot = false) {
  return {
    message_id: messageId,
    date: 1736380700,
    chat: groupChat,
    ...(fromBot ? { from: telegramBotInfoForTest } : {}),
    forum_topic_created: { name, icon_color: 7322096 },
    reply_to_message: undefined,
  };
}

describe("Telegram recorded session destinations", () => {
  it.each<[string, number | undefined, string]>([
    ["deleted direct session", undefined, "agent:main:telegram:direct:42001"],
    ["bot-private topic", 77, privateTopicKey],
  ])("persists the deliverable destination for %s", async (_name, thread, key) => {
    if (thread === undefined) {
      cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    }
    const bot = await createBot(false, true, cfg, thread !== undefined);
    if (thread === undefined) {
      await receive(bot, commandMessage("first turn"));
      await deleteSessionEntry({ storePath, sessionKey: key });
    }
    await receive(bot, {
      ...commandMessage("remember this destination"),
      chat,
      message_thread_id: thread,
    });
    const delivery = entry(key)?.delivery;
    expect(delivery).toMatchObject({
      kind: "external",
      context: deliveryContext("telegram:42001"),
    });
    expect(delivery?.kind === "external" ? delivery.context.threadId : null).toBe(
      thread?.toString(),
    );
    if (thread === undefined) {
      expect(delivery).toMatchObject({ origin: { provider: "telegram", chatType: "direct" } });
    }
  });

  it("keeps the Telegram-selected topic session through real /help initialization", async () => {
    const targetSessionKey = "agent:main:telegram-bound";
    const selectedSessionKey = targetSessionKey;
    const wrongSessionKeys = [
      "agent:main:telegram:direct:42001",
      "agent:main:telegram:direct:42001:thread:42001:42",
      "agent:main:telegram-bound:thread:42001:42",
    ];
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    cfg.commands = { native: false, text: true };
    cfg.agents = {
      ownership: "explicit",
      entries: { main: { workspace: harness.state.workspaceDir } },
      defaults: {
        workspace: harness.state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "openai/gpt-5.4" },
      },
    };
    cfg.plugins = { enabled: false };
    const previousFastTest = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    try {
      const bot = await createBot(false, true, cfg, true);
      await harness.state.writeConfig(cfg);
      bind(`${chat.id}:topic:42`, targetSessionKey);
      for (const sessionKey of [selectedSessionKey, ...wrongSessionKeys]) {
        expect(entry(sessionKey, "main")).toBeUndefined();
      }
      harness.replySpy.mockImplementation(async (context, options) => {
        expect(context).toMatchObject({ SessionKey: selectedSessionKey, CommandSource: "text" });
        expect(context.CommandTargetSessionKey).toBeUndefined();
        const reply = await getReplyFromConfig(context, options, cfg);
        const replies = Array.isArray(reply) ? reply : [reply];
        expect(replies.map((payload) => payload?.text ?? "").join("\n")).toContain("ℹ️ Help");
        return reply;
      });
      const startedAt = Date.now();
      await receive(bot, {
        ...commandMessage("/help"),
        message_thread_id: 42,
        is_topic_message: true,
      });
      expect(harness.replySpy).toHaveBeenCalledOnce();
      const sends = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
      expect(sends).toEqual([
        [
          "sendMessage",
          expect.objectContaining({
            chat_id: String(chat.id),
            text: expect.stringContaining("Help"),
            message_thread_id: 42,
          }),
        ],
      ]);
      const selected = entry(selectedSessionKey, "main");
      // Inbound metadata can create a row before the resolver; only real reply
      // initialization records the session start and interaction timestamps.
      expect(selected?.sessionStartedAt).toBeGreaterThanOrEqual(startedAt);
      expect(selected?.lastInteractionAt).toBeGreaterThanOrEqual(startedAt);
      for (const sessionKey of wrongSessionKeys) {
        expect(entry(sessionKey, "main")).toBeUndefined();
      }
    } finally {
      vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTest);
    }
  });

  it("isolates identity-linked senders and recorded destinations across named accounts", async () => {
    cfg.session = { ...cfg.session, identityLinks: { "alice-shared": ["telegram:814912386"] } };
    cfg.channels!.telegram!.accounts = { default: {}, atlas: {}, skynet: {} };
    const atlas = await createBot(false, true, cfg, false, "atlas");
    const skynet = await createBot(false, true, cfg, false, "skynet");
    for (const bot of [atlas, skynet]) {
      await receive(bot, {
        ...commandMessage("hello from the linked sender"),
        chat: { ...chat, id: 999999999 },
        from: { id: 814912386, is_bot: false, first_name: "Alice" },
      });
    }
    for (const accountId of ["atlas", "skynet"]) {
      expectDelivery(`agent:main:telegram:${accountId}:direct:alice-shared`, {
        accountId,
        to: "telegram:999999999",
      });
    }
  });

  it("admits plugin-bound ambient topics without replacing their channel session", async () => {
    cfg.channels!.telegram!.groups = {
      "*": { requireMention: true, requireMentionInBotThreads: true },
    };
    const pluginId = "openclaw-codex-app-server";
    const registry = getActivePluginRegistry();
    if (!registry) {
      throw new Error("Expected the native Telegram fixture registry");
    }
    registry.plugins.push(
      createPluginRecord({ id: pluginId, source: "/tmp/context-plugin/index.ts" }),
    );
    const claim = vi.fn<
      (
        event: PluginHookInboundClaimEvent,
        context: PluginHookInboundClaimContext,
      ) => PluginHookInboundClaimResult
    >(() => ({ handled: true }));
    addTestHook({ registry, pluginId, hookName: "inbound_claim", handler: claim });
    initializeGlobalHookRunner(registry);
    const bot = await createBot(false, true, cfg);
    bind("-10042001:topic:99", "plugin-binding:openclaw-codex-app-server:abc123", {
      pluginBindingOwner: "plugin",
      pluginId,
      pluginRoot: "/tmp/context-plugin",
    });
    await receive(bot, {
      ...groupCommand("ambient plugin input"),
      reply_to_message: topicReply("Plugin topic", 99, true),
    });
    expect(claim).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: "ambient plugin input" }),
      expect.objectContaining({
        channelId: "telegram",
        pluginBinding: expect.objectContaining({
          bindingId: "context-binding",
          pluginId,
          conversationId: "-10042001:topic:99",
        }),
      }),
    );
    await receive(bot, {
      ...groupCommand(""),
      text: undefined,
      caption: "ambient plugin media",
      photo,
    });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("ambient plugin media") }),
      expect.anything(),
    );
    expect(harness.replySpy).not.toHaveBeenCalled();
    expectDelivery(
      "agent:main:telegram:group:-10042001:topic:99",
      deliveryContext("telegram:-10042001:topic:99", "99"),
    );
  });

  it("keeps ordinary bindings mention-gated and preserves their recorded destination", async () => {
    cfg.channels!.telegram!.groups = { "*": { requireMention: true } };
    const bot = await createBot(false, true, cfg);
    bind("-10042001:topic:99", "agent:ops:acp:bound");
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:ops:acp:bound",
      entry: {
        sessionId: "bound-session",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: deliveryContext("telegram:555", "7"),
        }),
      },
    });
    await receive(bot, groupCommand("unmentioned ordinary binding"));
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, {
      ...groupCommand("@openclaw_bot hello"),
      entities: [{ type: "mention", offset: 0, length: 13 }],
    });
    expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toBe("agent:ops:acp:bound");
    expectDelivery("agent:ops:acp:bound", deliveryContext("telegram:555", "7"));
  });

  it("renames an existing private bot topic session from a title service update without a turn", async () => {
    const sessionKey = privateTopicKey;
    const bot = await createBot(false, true, cfg, true);
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "private-topic-session",
        updatedAt: 1,
        displayName: "New Chat",
        topicName: "Old topic name",
        delivery: normalizeSessionDeliveryState({
          context: { ...deliveryContext("telegram:42001", "77"), accountId: "default" },
          origin: {
            provider: "telegram",
            from: "telegram:direct:42001",
            to: "telegram:42001",
            accountId: "default",
            threadId: "77",
            label: "Old topic name",
          },
        }),
      },
    });
    const callsBefore = apiCalls.mock.calls.length;
    await receive(
      bot,
      serviceMessage({
        message_thread_id: 77,
        forum_topic_edited: { name: "Renamed personal topic" },
      }),
    );

    const updated = entry(sessionKey);
    expect(updated?.label).toBeUndefined();
    expect(updated).toMatchObject({
      displayName: "New Chat",
      topicName: "Renamed personal topic",
      updatedAt: 1,
      delivery: {
        context: { ...deliveryContext("telegram:42001", "77"), accountId: "default" },
        origin: { label: "Alice id:42001", threadId: 77 },
      },
    });
    expect(harness.replySpy).not.toHaveBeenCalled();
    const serviceCalls = apiCalls.mock.calls.slice(callsBefore).map(([method]) => method);
    expect(serviceCalls).not.toContain("sendMessage");
    expect(serviceCalls).not.toContain("sendChatAction");
  });

  it("does not create a private topic session from a title-only service update", async () => {
    const sessionKey = privateTopicKey;
    const bot = await createBot(false, true, cfg, true);
    await receive(
      bot,
      serviceMessage({
        forum_topic_edited: { name: "Topic without a thread identity" },
      }),
    );
    expect(entry(sessionKey)).toBeUndefined();
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(
      bot,
      serviceMessage({
        message_thread_id: 77,
        is_topic_message: true,
        forum_topic_created: { name: "New personal topic", icon_color: 7322096 },
      }),
    );
    expect(entry(sessionKey)).toBeUndefined();
    expect(harness.replySpy).not.toHaveBeenCalled();
  });

  it("learns reply topic names and restores them after plugin-state reopen", async () => {
    const bot = await createBot(false, true, cfg);
    await receive(bot, {
      ...groupCommand("first topic message"),
      reply_to_message: topicReply("Deployments", 3),
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      RawBody: "first topic message",
      TopicName: "Deployments",
    });
    await bot.stop();
    resetTelegramTopicNameCacheForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    setTelegramPluginStateRuntimeForTests();
    const reopened = await createBot(false, true, cfg);
    await receive(reopened, groupCommand("next message without service metadata"));
    expect(harness.replySpy).toHaveBeenCalledTimes(2);
    expect(harness.replySpy.mock.calls[1]?.[0]).toMatchObject({
      RawBody: "next message without service metadata",
      TopicName: "Deployments",
      SessionKey: "agent:main:telegram:group:-10042001:topic:99",
    });
  });
});
