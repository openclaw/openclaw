import path from "node:path";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import {
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { findTelegramPollRegistryEntry } from "./poll-registry.js";
import {
  createTelegramPromptContextProjectionCursor,
  resolveTelegramPromptContextDeliverySignature,
} from "./prompt-context-projection.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import {
  editMessageTelegram,
  sendLocationTelegram,
  sendMessageTelegram,
  sendPollTelegram,
} from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import { recordSentMessage, wasSentByBot } from "./sent-message-cache.js";
import type * as SentMessageCache from "./sent-message-cache.js";

describe("Telegram outbound history over HTTP and SQLite", () => {
  const fixture = useTelegramHttpFixture();
  let cfg: OpenClawConfig;
  let caseId = 0;
  const cache = () =>
    createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(cfg.session!.store!),
    });
  const providerMessage = (chatId: number, text: string, extra = {}) => ({
    message_id: 902,
    date: 1_779_394_740,
    chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
    from: { id: 123456, is_bot: true, first_name: "OpenClaw" },
    text,
    ...extra,
  });
  beforeEach(() => {
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramMessageCacheForTest();
    resetTelegramSentMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
    cfg = {
      ...fixture.cfg,
      session: { store: path.join(fixture.mediaDir, `sessions-${++caseId}.json`) },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetTelegramSentMessageCacheForTest();
    resetTelegramMessageCacheForTest();
    clearTelegramRuntimeForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it.each([false, true])(
    "attaches only matching durable-adapter provenance (rewritten: %s)",
    async (rewritten) => {
      const text = rewritten ? "Hook-rewritten answer" : "Final answer";
      fixture.responseFor = () => providerMessage(123, text);
      const result = await fixture.telegramOutbound.sendPayload!({
        cfg,
        to: "123",
        text: "",
        payload: {
          text,
          channelData: {
            telegram: {
              promptContextSource: {
                transcriptMessageId: "assistant-final",
                deliverySignature: resolveTelegramPromptContextDeliverySignature({
                  text: "Final answer",
                }),
              },
            },
          },
        },
      });
      const cached = await cache().get({
        accountId: "default",
        chatId: "123",
        messageId: result.messageId!,
      });
      expect(cached).toMatchObject({ body: text });
      expect(cached?.promptContextProjectionMarker).toEqual(
        rewritten
          ? undefined
          : {
              kind: "valid",
              projection: { transcriptMessageId: "assistant-final", partIndex: 0, finalPart: true },
            },
      );
      expect(fixture.requests.map(({ fields }) => fields.text)).toEqual([text]);
    },
  );

  it.each([
    { chatId: "-100123", kind: "text" },
    { chatId: "-100123", kind: "location" },
    { chatId: "123", kind: "text" },
  ])("retains accepted $kind in $chatId when history storage fails", async ({ chatId, kind }) => {
    const runtime = getTelegramRuntime();
    const open = runtime.state.openKeyedStore;
    vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
      if (options.namespace === TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE) {
        throw new Error("history storage unavailable");
      }
      return open(options);
    });
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "failed-history",
    });
    const opts = {
      cfg,
      api: fixture.bot.api,
      promptContextProjectionPlan: { cursor, finalPart: true },
    };
    const sending =
      kind === "text"
        ? sendMessageTelegram(chatId, "Delivered answer", opts)
        : sendLocationTelegram(chatId, { latitude: 48.858844, longitude: 2.294351 }, opts);
    if (chatId.startsWith("-")) {
      await expect(sending).rejects.toMatchObject({
        message: expect.stringContaining("history storage unavailable"),
        deliveryResult: { messageIds: ["1"], visibleReplySent: true },
      });
      expect(cursor.take(true).finalPart).toBe(false);
    } else {
      await expect(sending).resolves.toMatchObject({ messageId: "1", chatId });
    }
    expect(fixture.requests).toHaveLength(1);
  });

  it("records General-topic acceptance without inventing a private-chat General topic", async () => {
    fixture.responseFor = () => providerMessage(-100123, "Reply in General");
    await sendMessageTelegram("-100123:topic:1", "Reply in General", { cfg, api: fixture.bot.api });
    expect(fixture.requests[0]!.fields).not.toHaveProperty("message_thread_id");
    expect(
      hasProviderObservedTelegramThreadBinding(
        await cache().get({
          accountId: "default",
          chatId: "-100123",
          messageId: "902",
        }),
        1,
      ),
    ).toBe(true);
    fixture.responseFor = () => providerMessage(123, "Private topic");
    await expect(
      sendMessageTelegram("123:topic:1", "Private topic", { cfg, api: fixture.bot.api }),
    ).rejects.toThrow("topic unknown; expected topic 1");
  });

  it.each(["text", "location"] as const)(
    "keeps Telegram time and transcript provenance for %s",
    async (kind) => {
      fixture.responseFor = () => providerMessage(123, "Final answer");
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "assistant-final",
      });
      const opts = {
        cfg,
        api: fixture.bot.api,
        promptContextProjectionPlan: { cursor, finalPart: true },
      };
      if (kind === "text") {
        await sendMessageTelegram("123", "Final answer", opts);
      } else {
        await sendLocationTelegram("123", { latitude: 48.858844, longitude: 2.294351 }, opts);
      }
      const node = await cache().get({ accountId: "default", chatId: "123", messageId: "902" });
      expect(node?.timestamp).toBe(1_779_394_740_000);
      expect(node?.promptContextProjectionMarker).toEqual({
        kind: "valid",
        projection: { transcriptMessageId: "assistant-final", partIndex: 0, finalPart: true },
      });
    },
  );

  it.each(["text", "caption"] as const)(
    "refreshes authoritative edited %s without hiding later group history",
    async (kind) => {
      const original = providerMessage(-100123, "original response", { message_thread_id: 77 });
      fixture.responseFor = () => original;
      await sendMessageTelegram("-100123:topic:77", "original response", {
        cfg,
        api: fixture.bot.api,
      });
      await cache().record({
        accountId: "default",
        chatId: -100123,
        threadId: 77,
        historyEligible: true,
        msg: {
          message_id: 903,
          message_thread_id: 77,
          date: 1_779_394_741,
          chat: { id: -100123, type: "supergroup", title: "Ops" },
          from: { id: 43, is_bot: false, first_name: "Teammate" },
          text: "context that must remain visible",
        },
      });
      fixture.responseFor = () => ({
        ...original,
        text: kind === "text" ? "authoritative edited response" : undefined,
        ...(kind === "caption" ? { caption: "authoritative edited response" } : {}),
        edit_date: 1_779_394_750,
      });
      await editMessageTelegram("-100123", 902, "requested replacement", {
        cfg,
        api: fixture.bot.api,
        editMode: kind,
      });
      resetTelegramMessageCacheForTest();
      const history = await cache().readHistory({
        accountId: "default",
        chatId: -100123,
        threadId: 77,
        limit: 50,
      });
      expect(history.messages).toMatchObject([
        {
          messageId: "902",
          sender: "OpenClaw (you)",
          body: "authoritative edited response",
          timestamp: 1_779_394_740_000,
        },
        {
          messageId: "903",
          sender: "Teammate",
          body: "context that must remain visible",
          timestamp: 1_779_394_741_000,
        },
      ]);
      expect(history.hasMore).toBe(false);
      expect(
        hasProviderObservedTelegramThreadBinding(
          await cache().get({
            accountId: "default",
            chatId: -100123,
            messageId: "902",
          }),
          77,
        ),
      ).toBe(true);
    },
  );

  it.each(["html-recovery", "middle-rejection", "rich-recovery", "empty-tail"] as const)(
    "projects only accepted chunks through %s",
    async (outcome) => {
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "multipart",
      });
      const empty = "Bad Request: text must be non-empty";
      fixture.responseFor = (method) =>
        method === "sendMessage"
          ? {
              message_id: fixture.requests.length,
              date: 1_779_394_740,
              chat: { id: 123, type: "private" },
            }
          : undefined;
      fixture.rejections.push(
        ...(outcome === "html-recovery"
          ? ["Bad Request: can't parse entities"]
          : outcome === "empty-tail"
            ? ["", empty, empty]
            : outcome === "rich-recovery"
              ? [
                  "Bad Request: RICH_MESSAGE_EMAIL_INVALID",
                  "",
                  "Bad Request: chunk content rejected",
                ]
              : ["", "Bad Request: chunk content rejected"]),
      );
      const sending = sendMessageTelegram(
        "123",
        outcome === "html-recovery"
          ? "<".repeat(1000) + "y".repeat(3000)
          : outcome === "empty-tail"
            ? `${"A".repeat(4000)}\u200b\u200b`
            : "A".repeat(9000),
        {
          cfg: {
            ...cfg,
            channels: {
              telegram: {
                ...fixture.cfg.channels.telegram,
                richMessages: outcome === "rich-recovery",
              },
            },
          },
          api: fixture.bot.api,
          ...(outcome === "rich-recovery" ? {} : { textMode: "html" as const }),
          buttons: fixture.buttons,
          promptContextProjectionPlan: { cursor, finalPart: true },
        },
      );
      const incomplete = outcome === "middle-rejection" || outcome === "rich-recovery";
      const ids =
        outcome === "html-recovery"
          ? ["2", "3"]
          : outcome === "empty-tail"
            ? ["1"]
            : outcome === "rich-recovery"
              ? ["2", "4"]
              : ["1", "3"];
      if (incomplete) {
        await expect(sending).rejects.toMatchObject({ deliveryResult: { messageIds: ids } });
      } else {
        await sending;
      }
      const nodes = await Promise.all(
        ids.map((messageId) => cache().get({ accountId: "default", chatId: "123", messageId })),
      );
      expect(nodes.map((node) => node?.body)).toEqual(
        outcome === "html-recovery"
          ? ["<".repeat(1000), "y".repeat(3000)]
          : outcome === "empty-tail"
            ? ["A".repeat(4000)]
            : ["A".repeat(4000), "A".repeat(1000)],
      );
      expect(nodes.map((node) => node?.promptContextProjectionMarker)).toEqual(
        ids.map((_, partIndex) => ({
          kind: "valid",
          projection: {
            transcriptMessageId: "multipart",
            partIndex,
            finalPart: !incomplete && partIndex === ids.length - 1,
          },
        })),
      );
      if (outcome === "empty-tail") {
        expect(fixture.requests.at(-1)).toEqual({
          method: "editMessageReplyMarkup",
          fields: {
            chat_id: 123,
            message_id: 1,
            reply_markup: { inline_keyboard: fixture.buttons },
          },
        });
      }
    },
  );

  it.each([
    { name: "DM", chatId: 123, type: "private", thread: undefined, scope: { scope: "dm" } },
    { name: "DM topic", chatId: 123, type: "private", thread: 42, scope: { scope: "dm", id: 42 } },
    {
      name: "group",
      chatId: -100123,
      type: "supergroup",
      thread: undefined,
      scope: { scope: "none" },
    },
    {
      name: "forum",
      chatId: -100123,
      type: "supergroup",
      thread: 77,
      scope: { scope: "forum", id: 77 },
    },
    {
      name: "General",
      chatId: -100123,
      type: "supergroup",
      thread: 1,
      scope: { scope: "forum", id: 1 },
    },
  ])(
    "persists the accepted $name public-poll route for later votes",
    async ({ name, chatId, type, thread, scope }) => {
      fixture.responseFor = (method) =>
        method === "getChatMember"
          ? { status: "administrator" }
          : {
              message_id: 500,
              date: 1_779_394_740,
              chat: {
                id: chatId,
                type,
                first_name: "Ada",
                title: "Reviewers",
                ...(thread && chatId < 0 ? { is_forum: true } : {}),
              },
              ...(thread && thread !== 1 ? { message_thread_id: thread } : {}),
              poll: {
                id: name,
                question: "Ready?",
                options: [
                  { text: "Yes", voter_count: 0 },
                  { text: "No", voter_count: 0 },
                ],
                total_voter_count: 0,
                is_closed: false,
                is_anonymous: false,
                type: "regular",
                allows_multiple_answers: false,
                allows_revoting: false,
                members_only: false,
              },
            };
      const target = `${chatId}${thread ? `:topic:${thread}` : ""}`;
      await expect(
        sendPollTelegram(
          target,
          { question: " Ready? ", options: [" Yes ", "No "] },
          {
            cfg,
            api: fixture.bot.api,
            isAnonymous: false,
          },
        ),
      ).resolves.toMatchObject({ messageId: "500", pollAnswerRouting: "enabled" });
      expect(await findTelegramPollRegistryEntry({ pollId: name })).toMatchObject({
        messageId: 500,
        threadSpec: scope,
        question: "Ready?",
        options: ["Yes", "No"],
      });
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        chatId < 0 ? ["sendPoll", "getChatMember"] : ["sendPoll"],
      );
    },
  );

  const unavailablePollScenarios: Array<{
    name: string;
    policy: TelegramAccountConfig;
    type: "private" | "supergroup" | "channel";
    status?: "administrator" | "member";
    thread?: number;
    warning: string;
    anonymous?: boolean;
  }> = [
    {
      name: "anonymous",
      policy: {},
      anonymous: true,
      type: "supergroup",
      status: "administrator",
      warning: "anonymously",
    },
    {
      name: "channel",
      policy: {},
      type: "channel",
      status: "administrator",
      warning: "Telegram channels",
    },
    {
      name: "non-admin",
      policy: {},
      type: "supergroup",
      status: "member",
      warning: "not an administrator",
    },
    {
      name: "account-disabled",
      policy: { groupPolicy: "disabled" },
      type: "supergroup",
      warning: "inbound messages are disabled",
    },
    {
      name: "group-disabled",
      policy: { groups: { "-100123": { enabled: false } } },
      type: "supergroup",
      warning: "inbound messages are disabled",
    },
    {
      name: "topic-disabled",
      policy: { groups: { "-100123": { topics: { "77": { enabled: false } } } } },
      thread: 77,
      type: "supergroup",
      warning: "inbound messages are disabled",
    },
    {
      name: "topic-policy",
      policy: {
        groupPolicy: "open",
        groups: { "-100123": { topics: { "77": { groupPolicy: "disabled" } } } },
      },
      thread: 77,
      type: "supergroup",
      warning: "inbound messages are disabled",
    },
    {
      name: "General-policy",
      policy: {
        groupPolicy: "open",
        groups: { "-100123": { topics: { "1": { groupPolicy: "disabled" } } } },
      },
      thread: 1,
      type: "supergroup",
      warning: "inbound messages are disabled",
    },
    {
      name: "write-failure",
      policy: {},
      type: "private",
      warning: "routing state could not be saved",
    },
  ];
  it.each(unavailablePollScenarios)(
    "warns after accepted $name polls without advertising a usable route or resending",
    async (scenario) => {
      const chatId = scenario.type === "private" ? 123 : -100123;
      const thread = "thread" in scenario ? scenario.thread : undefined;
      fixture.responseFor = (method) =>
        method === "getChatMember"
          ? { status: "status" in scenario ? scenario.status : "administrator" }
          : {
              message_id: 500,
              date: 1_779_394_740,
              chat: {
                id: chatId,
                type: scenario.type,
                first_name: "Ada",
                title: "Reviewers",
                ...(thread ? { is_forum: true } : {}),
              },
              ...(thread && thread !== 1 ? { message_thread_id: thread } : {}),
              poll: {
                id: scenario.name,
                question: "Ready?",
                options: [
                  { text: "Yes", voter_count: 0 },
                  { text: "No", voter_count: 0 },
                ],
                total_voter_count: 0,
                is_closed: false,
                is_anonymous: scenario.name === "anonymous",
                type: "regular",
                allows_multiple_answers: false,
                allows_revoting: false,
                members_only: false,
              },
            };
      if (scenario.name === "write-failure") {
        const state = getTelegramRuntime().state;
        const open = state.openKeyedStore;
        vi.spyOn(state, "openKeyedStore").mockImplementation((options) => {
          const store = open(options);
          return options.namespace === "telegram.poll-registry"
            ? {
                ...store,
                register: async () => {
                  throw new Error("registry unavailable");
                },
              }
            : store;
        });
      }
      await expect(
        sendPollTelegram(
          `${chatId}${thread ? `:topic:${thread}` : ""}`,
          { question: "Ready?", options: ["Yes", "No"] },
          {
            cfg: {
              ...cfg,
              channels: { telegram: { ...fixture.cfg.channels.telegram, ...scenario.policy } },
            },
            api: fixture.bot.api,
            isAnonymous: scenario.name === "anonymous",
          },
        ),
      ).resolves.toMatchObject({
        messageId: "500",
        pollAnswerRouting: "unavailable",
        warning: expect.stringContaining(scenario.warning),
      });
      expect(await findTelegramPollRegistryEntry({ pollId: scenario.name })).toBeNull();
      expect(fixture.requests.map(({ method }) => method)).toEqual(
        scenario.name === "non-admin" ? ["sendPoll", "getChatMember"] : ["sendPoll"],
      );
    },
  );

  it("shares cold hydration while waiting for durable ownership persistence", async () => {
    const state = getTelegramRuntime().state;
    const open = state.openKeyedStore;
    const hydration = createDeferred<never[]>();
    const persistence = createDeferred<void>();
    const entries = vi.fn(() => hydration.promise);
    vi.spyOn(state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => ({
        ...open<T>(options),
        entries,
        register: () => persistence.promise,
      }),
    );
    let finished = false;
    const recording = recordSentMessage(123, 1, cfg).then(() => {
      finished = true;
    });
    const lookup = wasSentByBot("123", 1, cfg);
    expect(entries).toHaveBeenCalledOnce();
    hydration.resolve([]);
    await expect(lookup).resolves.toBe(true);
    expect(finished).toBe(false);
    persistence.resolve();
    await recording;
    expect(finished).toBe(true);
  });

  it("writes each accepted ownership row once with its own TTL", async () => {
    const state = getTelegramRuntime().state;
    const open = state.openKeyedStore;
    const writes: Array<[unknown, number | undefined]> = [];
    vi.spyOn(state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => {
        const store = open<T>(options);
        return {
          ...store,
          register: async (key, value, registration) => {
            await store.register(key, value, registration);
            writes.push([value, registration?.ttlMs]);
          },
        };
      },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await recordSentMessage(123, 1, cfg);
    now.mockReturnValue(1_800_003_600_000);
    await recordSentMessage(123, 2, cfg);
    expect(writes).toEqual([
      [expect.objectContaining({ messageId: "1" }), 86_400_000],
      [expect.objectContaining({ messageId: "2" }), 86_400_000],
    ]);
    now.mockReturnValue(1_800_086_400_000);
    expect(await wasSentByBot(123, 1, cfg)).toBe(false);
    expect(await wasSentByBot(123, 2, cfg)).toBe(true);
  });

  it("keeps ownership best-effort when its backing store is unavailable", async () => {
    const state = getTelegramRuntime().state;
    const open = state.openKeyedStore;
    vi.spyOn(state, "openKeyedStore").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => ({
        ...open<T>(options),
        entries: async () => {
          throw new Error("read unavailable");
        },
        register: async () => {
          throw new Error("write unavailable");
        },
      }),
    );
    await recordSentMessage(123, 1, cfg);
    expect(await wasSentByBot(123, 1, cfg)).toBe(true);
  });

  it("rehydrates ownership across module and database restarts without crossing account or store scopes", async () => {
    const scoped: OpenClawConfig = {
      ...cfg,
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      channels: {
        telegram: {
          accounts: { primary: { botToken: "123:primary" }, alerts: { botToken: "456:alerts" } },
        },
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "primary" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "alerts" } },
      ],
      session: { store: path.join(fixture.mediaDir, "{agentId}", "sessions.json") },
    };
    await recordSentMessage(123, 1, scoped, { accountId: "primary" });
    const separate = await importFreshModule<typeof SentMessageCache>(
      import.meta.url,
      "./sent-message-cache.js?scope=send-history",
    );
    expect(await separate.wasSentByBot(123, 1, scoped, { accountId: "primary" })).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    resetTelegramSentMessageCacheForTest();
    expect(await separate.wasSentByBot(123, 1, scoped, { accountId: "primary" })).toBe(true);
    expect(await separate.wasSentByBot(123, 1, scoped, { accountId: "alerts" })).toBe(false);
    expect(await separate.wasSentByBot(123, 1, cfg)).toBe(false);
    await separate.recordSentMessage(123, 2, cfg);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_001);
    await separate.recordSentMessage(123, 3, cfg);
    expect(await separate.wasSentByBot(123, 1, scoped, { accountId: "primary" })).toBe(false);
    expect(await separate.wasSentByBot(123, 3, cfg)).toBe(true);
    expect(await separate.wasSentByBot(123, 3, scoped, { accountId: "primary" })).toBe(false);
  });
});
