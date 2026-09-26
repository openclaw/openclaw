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
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  chat,
  commandMessage,
  createBot,
  groupChat,
  groupCommand,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let cfg: OpenClawConfig;
let storePath: string;
let updateId = 6000;

beforeEach(() => {
  storePath = path.join(tempDirs.make("telegram-context-session-"), "sessions.json");
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
  // Telegram JSON omits grammY's undefined-only reply fields.
  const request = new Request("http://localhost/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: ++updateId,
      message: { ...message, entities: message.text?.startsWith("@") ? message.entities : [] },
    } satisfies Update),
  });
  await bot.handleUpdate(await request.json());
}

describe("Telegram recorded session destinations", () => {
  it("records a deleted direct session again when the next DM is processed", async () => {
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    const bot = await createBot(false, true, cfg);
    await receive(bot, commandMessage("first turn"));
    await deleteSessionEntry({ storePath, sessionKey: "agent:main:telegram:direct:42001" });
    await receive(bot, commandMessage("hello again"));
    expect(
      getSessionEntry({ storePath, sessionKey: "agent:main:telegram:direct:42001" })?.delivery,
    ).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "telegram:42001" },
      origin: { provider: "telegram", chatType: "direct" },
    });
  });

  it.each([
    {
      name: "flat DM",
      group: false,
      thread: undefined,
      key: "agent:main:main",
      to: "telegram:42001",
      savedThread: undefined,
    },
    {
      name: "bot-private topic",
      group: false,
      thread: 77,
      key: "agent:main:main:thread:42001:77",
      to: "telegram:42001",
      savedThread: "77",
    },
    {
      name: "forum topic",
      group: true,
      thread: 99,
      key: "agent:main:telegram:group:-10042001:topic:99",
      to: "telegram:-10042001:topic:99",
      savedThread: "99",
    },
    {
      name: "General topic",
      group: true,
      thread: 1,
      key: "agent:main:telegram:group:-10042001:topic:1",
      to: "telegram:-10042001",
      savedThread: "1",
    },
  ])(
    "persists the deliverable destination for $name",
    async ({ group, thread, key, to, savedThread }) => {
      const bot = await createBot(false, true, cfg, true);
      await receive(bot, {
        ...commandMessage("remember this destination"),
        chat: group ? groupChat : chat,
        message_thread_id: thread,
        ...(group ? { is_topic_message: true } : {}),
      });
      const delivery = getSessionEntry({ storePath, sessionKey: key })?.delivery;
      expect(delivery).toMatchObject({ kind: "external", context: { channel: "telegram", to } });
      expect(delivery?.kind === "external" ? delivery.context.threadId : null).toBe(savedThread);
    },
  );

  it.each([false, true])(
    "keeps the Telegram-selected session through real /help initialization with DM topic=%s",
    async (isTopic) => {
      const targetSessionKey = "agent:main:telegram-bound";
      const selectedSessionKey = isTopic
        ? "agent:main:telegram-bound:thread:42001:42"
        : targetSessionKey;
      const wrongSessionKeys = [
        "agent:main:telegram:direct:42001",
        ...(isTopic ? ["agent:main:telegram:direct:42001:thread:42001:42", targetSessionKey] : []),
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
        const bot = await createBot(false, true, cfg, isTopic);
        await harness.state.writeConfig(cfg);
        bind(String(chat.id), targetSessionKey);
        for (const sessionKey of [selectedSessionKey, ...wrongSessionKeys]) {
          expect(getSessionEntry({ agentId: "main", storePath, sessionKey })).toBeUndefined();
        }
        harness.replySpy.mockImplementation(async (context, options) => {
          expect(context.SessionKey).toBe(selectedSessionKey);
          expect(context.CommandSource).toBe("text");
          expect(context.CommandTargetSessionKey).toBeUndefined();
          const reply = await getReplyFromConfig(context, options, cfg);
          const replies = Array.isArray(reply) ? reply : [reply];
          expect(replies.map((payload) => payload?.text ?? "").join("\n")).toContain("ℹ️ Help");
          return reply;
        });
        const startedAt = Date.now();
        await receive(bot, {
          ...commandMessage("/help"),
          ...(isTopic ? { message_thread_id: 42, is_topic_message: true } : {}),
        });
        expect(harness.replySpy).toHaveBeenCalledOnce();
        const sends = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
        expect(sends).toEqual([
          [
            "sendMessage",
            expect.objectContaining({
              chat_id: String(chat.id),
              text: expect.stringContaining("Help"),
              ...(isTopic ? { message_thread_id: 42 } : {}),
            }),
          ],
        ]);
        if (!isTopic) {
          expect(sends[0]?.[1]).not.toHaveProperty("message_thread_id");
        }
        const selected = getSessionEntry({
          agentId: "main",
          storePath,
          sessionKey: selectedSessionKey,
        });
        // Inbound metadata can create a row before the resolver; only real reply
        // initialization records the session start and interaction timestamps.
        expect(selected?.sessionStartedAt).toBeGreaterThanOrEqual(startedAt);
        expect(selected?.lastInteractionAt).toBeGreaterThanOrEqual(startedAt);
        for (const sessionKey of wrongSessionKeys) {
          expect(getSessionEntry({ agentId: "main", storePath, sessionKey })).toBeUndefined();
        }
      } finally {
        vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTest);
      }
    },
  );

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
    expect(
      getSessionEntry({ storePath, sessionKey: "agent:main:telegram:atlas:direct:alice-shared" })
        ?.delivery,
    ).toMatchObject({
      kind: "external",
      context: { accountId: "atlas", to: "telegram:999999999" },
    });
    expect(
      getSessionEntry({ storePath, sessionKey: "agent:main:telegram:skynet:direct:alice-shared" })
        ?.delivery,
    ).toMatchObject({
      kind: "external",
      context: { accountId: "skynet", to: "telegram:999999999" },
    });
  });

  it("keeps inbound DMs out of stale cron-run bindings", async () => {
    const bot = await createBot(false, true, cfg);
    bind("42001", "agent:youtube:cron:monthly-report:run:closed-run-1");
    await receive(bot, commandMessage("a new live conversation"));
    expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toBe("agent:main:main");
    expect(getSessionEntry({ storePath, sessionKey: "agent:main:main" })?.delivery).toMatchObject({
      kind: "external",
      context: { to: "telegram:42001" },
    });
    expect(
      getSessionEntry({
        storePath,
        sessionKey: "agent:youtube:cron:monthly-report:run:closed-run-1",
      }),
    ).toBeUndefined();
  });

  it("admits plugin-bound ambient topics without replacing their channel session", async () => {
    cfg.channels!.telegram!.groups = { "*": { requireMention: true } };
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
      pluginId: "openclaw-codex-app-server",
      pluginRoot: "/tmp/context-plugin",
    });
    await receive(bot, groupCommand("ambient plugin input"));
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
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(
      getSessionEntry({ storePath, sessionKey: "agent:main:telegram:group:-10042001:topic:99" })
        ?.delivery,
    ).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "telegram:-10042001:topic:99", threadId: "99" },
    });
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
          context: { channel: "telegram", to: "telegram:555", threadId: "7" },
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
    expect(
      getSessionEntry({ storePath, sessionKey: "agent:ops:acp:bound" })?.delivery,
    ).toMatchObject({
      kind: "external",
      context: { channel: "telegram", to: "telegram:555", threadId: "7" },
    });
  });

  it("learns reply topic names and restores them after plugin-state reopen", async () => {
    const bot = await createBot(false, true, cfg);
    await receive(bot, {
      ...groupCommand("first topic message"),
      reply_to_message: {
        message_id: 3,
        date: 1736380700,
        chat: groupChat,
        forum_topic_created: { name: "Deployments", icon_color: 0x6fb9f0 },
        reply_to_message: undefined,
      },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      RawBody: "first topic message",
      TopicName: "Deployments",
    });
    await bot.stop();
    await closeOpenClawAgentDatabasesAsync(path.dirname(storePath));
    resetTelegramTopicNameCacheForTest();
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
