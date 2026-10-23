import type { Message } from "grammy/types";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreV2ForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramMessageContextRuntime,
  createTelegramMessageSessionRuntime,
} from "./bot-handlers.message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import { telegramPromptContextHistory } from "./group-history-window.js";
import { readTelegramHistory } from "./history-policy.js";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
  type PersistedTelegramMessageCacheValue,
} from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const CHAT_ID = 5678;
const TOPIC_ID = 77;

let storeScopeId = 0;

const resolveStorePathMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  resolveStorePath: resolveStorePathMock,
}));

function createRuntime(cfg: OpenClawConfig = {}, accountId = "default") {
  const runtime = createTelegramMessageContextRuntime({
    cfg,
    accountId,
    ownerAgentId: "main",
    opts: {},
    telegramCfg: cfg.channels?.telegram ?? {},
  });
  return {
    ...runtime,
    prompt: (
      msg: Message,
      options?: TelegramMessageContextOptions,
      replyChain: Parameters<typeof runtime.buildPromptContextForMessage>[2] = [],
    ) =>
      runtime.buildPromptContextForMessage(
        { message: msg, getFile: vi.fn() },
        msg,
        replyChain,
        cfg,
        cfg.channels?.telegram ?? {},
        options,
      ),
  };
}

function isolateStoreScope() {
  resolveStorePathMock.mockReturnValue(
    `/tmp/openclaw-telegram-thread-recovery-${++storeScopeId}/store.json`,
  );
}

beforeEach(() => {
  resolveStorePathMock.mockClear();
  isolateStoreScope();
});

afterEach(() => {
  resetTelegramMessageCacheForTest();
  clearTelegramRuntimeForTest();
});

function forumMessage(messageId: number, threadId?: number): Message {
  return {
    chat: { id: CHAT_ID, type: "supergroup", title: "Forum", is_forum: true },
    message_id: messageId,
    date: 1736380800,
    text: "topic message",
    from: { id: 10, is_bot: false, first_name: "Bob" },
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  } as Message;
}

describe("resolveCachedMessageThreadSpec", () => {
  it("keeps account cache ownership separate from a topic-routed session owner", async () => {
    const resolveStorePath = resolveStorePathMock.mockImplementation(
      (_store?: string, options?: { agentId?: string }) =>
        `/tmp/openclaw-telegram-owner-${options?.agentId}.json`,
    );
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, research: {} },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
    } as OpenClawConfig;
    createRuntime(cfg, "primary");
    const sessionRuntime = createTelegramMessageSessionRuntime({
      accountId: "primary",
      resolveTelegramGroupConfig: () => ({ topicConfig: { agentId: "research" } }),
    });

    const session = await sessionRuntime.resolveTelegramSessionState({
      chatId: CHAT_ID,
      isGroup: true,
      threadSpec: { id: TOPIC_ID, scope: "forum" },
      senderId: 10,
      runtimeCfg: cfg,
    });

    expect(resolveStorePath.mock.calls.map(([, options]) => options?.agentId)).toEqual([
      "main",
      "research",
    ]);
    expect(session).toMatchObject({
      agentId: "research",
      storePath: "/tmp/openclaw-telegram-owner-research.json",
    });
    expect(session.sessionKey).toContain("agent:research:");
  });

  it("returns undefined for a message that is not in the cache", async () => {
    const runtime = createRuntime();

    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 404 }),
    ).resolves.toBeUndefined();
  });

  it("recovers a channel Direct Messages scope without reusing raw message_thread_id", async () => {
    const runtime = createRuntime();
    const msg = {
      ...forumMessage(102, 999),
      chat: {
        id: CHAT_ID,
        type: "supergroup",
        title: "Channel replies",
        is_direct_messages: true,
      },
      direct_messages_topic: { topic_id: TOPIC_ID },
    } as Message;
    await runtime.recordMessageForReplyChain(msg, {
      scope: "direct-messages",
      id: TOPIC_ID,
    });

    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 102 }),
    ).resolves.toEqual({
      threadSpec: { scope: "direct-messages", id: TOPIC_ID },
      isTopicMessage: false,
    });
  });
});

describe("automatic Telegram retained history workload", () => {
  const archiveSize = 50_512;
  const chatId = -10081;
  const accountId = "default";
  const storePath = "/automatic-telegram-history/store.json";
  const scope = resolveTelegramMessageCacheScope(storePath);
  const keyPrefix = `${resolveTelegramMessageCachePersistentScopeKey(scope)}:${accountId}:${chatId}:`;
  const date = 1_736_380_800;
  let state: OpenClawTestState;
  let reads = { pages: 0, rows: 0, lookups: 0, fullReads: 0 };

  function archivedMessage(messageId: number): Message {
    const threadId =
      messageId <= 50_256 || messageId === 50_300 || messageId === 50_500 ? 77 : undefined;
    return {
      chat: { id: chatId, type: "supergroup", title: "Archive", is_forum: true },
      message_id: messageId,
      date: date + messageId,
      text: messageId === 1 ? "The launch code is cobalt." : `Message ${messageId}`,
      from: {
        id: messageId <= 50_256 || messageId === 50_301 || messageId === 50_501 ? 10 : 20,
        is_bot: false,
        first_name: "Participant",
      },
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    };
  }

  function historyRuntime(telegramCfg: TelegramAccountConfig = { groupPolicy: "open" }) {
    const cfg: OpenClawConfig = { channels: { telegram: telegramCfg } };
    resolveStorePathMock.mockReturnValue(storePath);
    return {
      runtime: createRuntime(cfg, accountId),
      read: (before: string, limit: number) =>
        readTelegramHistory({
          cache: createTelegramMessageCache({ scope }),
          cfg,
          accountId,
          chatId,
          threadId: TOPIC_ID,
          before,
          limit,
        }),
    };
  }

  beforeAll(async () => {
    closeOpenClawStateDatabaseForTest();
    state = await createOpenClawTestState({
      label: "telegram-automatic-history",
      layout: "state-only",
    });
    const { db } = openOpenClawStateDatabase({ env: state.env });
    const kysely =
      getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabaseForTests, "plugin_state_entries">>(db);
    for (let offset = 0; offset < archiveSize; offset += 512) {
      const rows = Array.from({ length: Math.min(512, archiveSize - offset) }, (_, index) => {
        const messageId = offset + index + 1;
        const sourceMessage = archivedMessage(messageId);
        const value: PersistedTelegramMessageCacheValue = {
          version: 1,
          sourceMessage,
          historyEligible: true,
          threadId: sourceMessage.message_thread_id?.toString(),
        };
        return {
          plugin_id: "telegram",
          namespace: `@retained.${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`,
          entry_key: `${keyPrefix}${String(messageId).padStart(10, "0")}`,
          value_json: JSON.stringify(value),
          created_at: messageId,
          expires_at: null,
        };
      });
      executeSqliteQuerySync(db, kysely.insertInto("plugin_state_entries").values(rows));
    }
  });

  beforeEach(() => {
    reads = { pages: 0, rows: 0, lookups: 0, fullReads: 0 };
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStoreV2"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ): PluginStateKeyedStore<T, 2> => {
      const store = createPluginStateKeyedStoreV2ForTests<T>(
        "telegram",
        { ...options, env: state.env },
        { assertCurrent() {} },
      );
      return {
        ...store,
        async entries() {
          reads.fullReads++;
          return store.entries();
        },
        async lookup(key) {
          reads.lookups++;
          return store.lookup(key);
        },
        async entriesInKeyRange(range) {
          const page = await store.entriesInKeyRange(range);
          reads.pages++;
          reads.rows += page.length;
          return page;
        },
      };
    };
    setTelegramRuntime(
      createPluginRuntimeMock({ state: { openKeyedStore, openKeyedStoreV2: openKeyedStore } }),
    );
  });

  afterAll(async () => {
    resetPluginStateStoreForTests();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it("does not read storage when automatic history is zero and there is no reply", async () => {
    const { runtime } = historyRuntime({ groupPolicy: "open", historyLimit: 0 });
    const msg = archivedMessage(archiveSize + 1);
    const replyChain = await runtime.buildReplyChainForMessage(msg);
    expect(await runtime.prompt(msg, undefined, replyChain)).toEqual([]);
    expect(reads).toEqual({ pages: 0, rows: 0, lookups: 0, fullReads: 0 });
  });

  it.each([
    { name: "sparse topic", threadId: 77, restricted: false, expected: ["50300", "50500"] },
    {
      name: "current sender policy",
      threadId: undefined,
      restricted: true,
      expected: ["50301", "50501"],
    },
  ])(
    "does not extend the physical window to fill $name matches",
    async ({ threadId, restricted, expected }) => {
      const { runtime, read } = historyRuntime(
        restricted
          ? { groupPolicy: "allowlist", groupAllowFrom: ["10"], groups: { "*": { enabled: true } } }
          : { groupPolicy: "open" },
      );
      const msg = archivedMessage(archiveSize + 1);
      const context = await runtime.prompt(msg, {
        threadSpec: threadId === undefined ? { scope: "none" } : { scope: "forum", id: threadId },
      });
      expect(telegramPromptContextHistory(context).map((entry) => entry.messageId)).toEqual(
        expected,
      );
      expect(reads.rows).toBeLessThanOrEqual(256);
      expect(reads.pages).toBeLessThanOrEqual(2);

      if (threadId !== undefined) {
        const earlier = await read("50300", 3);
        expect(earlier.messages.map((entry) => entry.messageId)).toEqual([
          "50254",
          "50255",
          "50256",
        ]);
        expect(earlier.hasMore).toBe(true);
      }
    },
  );

  it("uses the canonical reset boundary after reopen without erasing explicit history", async () => {
    const msg = archivedMessage(archiveSize + 1);
    const options = {
      promptContextMinTimestampMs: (date + 50_509) * 1000,
      promptContextAmbientWatermark: { messageId: "50504", timestampMs: (date + 50_504) * 1000 },
    };
    for (let reopen = 0; reopen < 2; reopen++) {
      const { runtime } = historyRuntime();
      const context = await runtime.prompt(msg, options);
      expect(telegramPromptContextHistory(context).map((entry) => entry.messageId)).toEqual([
        "50509",
        "50510",
        "50511",
        "50512",
      ]);
      expect(reads.rows).toBeLessThanOrEqual(256);
      expect(reads.pages).toBeLessThanOrEqual(2);
      resetTelegramMessageCacheForTest();
      reads = { pages: 0, rows: 0, lookups: 0, fullReads: 0 };
    }
    const earlier = await historyRuntime().read("2", 1);
    expect(earlier.messages.map((entry) => entry.body)).toEqual(["The launch code is cobalt."]);
    expect(earlier.hasMore).toBe(false);
  });
});

describe("Telegram same-turn reset context", () => {
  it("keeps soft-reset context but drops a hard reset in group chats", async () => {
    const cfg: OpenClawConfig = { channels: { telegram: { groupPolicy: "open" } } };
    const previous = {
      ...forumMessage(100),
      chat: { id: 7, type: "group", title: "Room" },
    } satisfies Message;
    for (const text of ["/new", "/reset@openclaw_bot", "/reset soft continue"]) {
      isolateStoreScope();
      const runtime = createRuntime(cfg);
      await runtime.recordMessageForReplyChain(previous);
      const msg = { ...previous, message_id: 101, date: previous.date + 1, text };
      await runtime.recordMessageForReplyChain(msg);
      const context = await runtime.prompt(msg);
      expect(telegramPromptContextHistory(context).map((entry) => entry.messageId)).toEqual(
        text.includes("soft") ? ["100"] : [],
      );
    }
  });
});
