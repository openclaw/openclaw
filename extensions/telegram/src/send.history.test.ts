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
  sendTypingTelegram,
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
  const getCached = (messageId: string, chatId: string | number = "123") =>
    cache().get({ accountId: "default", chatId, messageId });
  const sendOptions = () => ({ cfg, api: fixture.bot.api });
  const withPolicy = (policy: TelegramAccountConfig): OpenClawConfig => ({
    ...cfg,
    channels: { telegram: { ...fixture.cfg.channels.telegram, ...policy } },
  });
  const providerMessage = (chatId: number, text: string, extra = {}) => ({
    message_id: 902,
    date: 1_779_394_740,
    chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
    from: { id: 123456, is_bot: true, first_name: "OpenClaw" },
    text,
    ...extra,
  });
  const pollMessage = (chatId: number, type: string, id: string, thread?: number) => ({
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
      id,
      question: "Ready?",
      options: [
        { text: "Yes", voter_count: 0 },
        { text: "No", voter_count: 0 },
      ],
      total_voter_count: 0,
      is_closed: false,
      is_anonymous: id === "anonymous",
      type: "regular",
      allows_multiple_answers: false,
      allows_revoting: false,
      members_only: false,
    },
  });
  const cursorFor = (transcriptMessageId: string) =>
    createTelegramPromptContextProjectionCursor({ transcriptMessageId });
  const projectionMarker = (transcriptMessageId: string, partIndex = 0, finalPart = true) => ({
    kind: "valid",
    projection: { transcriptMessageId, partIndex, finalPart },
  });
  const mockStore = (
    transform: <T>(
      store: PluginStateKeyedStore<T>,
      options: OpenAsyncKeyedStoreOptions,
    ) => PluginStateKeyedStore<T>,
  ) => {
    const state = getTelegramRuntime().state;
    const open = state.openKeyedStore;
    vi.spyOn(state, "openKeyedStore").mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) =>
      transform(open<T>(options), options),
    );
  };
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
      const promptContextSource = {
        transcriptMessageId: "assistant-final",
        deliverySignature: resolveTelegramPromptContextDeliverySignature({ text: "Final answer" }),
      };
      const result = await fixture.telegramOutbound.sendPayload!({
        cfg,
        to: "123",
        text: "",
        payload: { text, channelData: { telegram: { promptContextSource } } },
      });
      const cached = await getCached(result.messageId!);
      expect(cached).toMatchObject({ body: text });
      expect(cached?.promptContextProjectionMarker).toEqual(
        rewritten ? undefined : projectionMarker("assistant-final"),
      );
      expect(fixture.requests.map(({ fields }) => fields.text)).toEqual([text]);
    },
  );

  it.each([
    { chatId: "-100123", kind: "text" },
    { chatId: "-100123", kind: "location" },
    { chatId: "123", kind: "text" },
  ])("retains accepted $kind in $chatId when history storage fails", async ({ chatId, kind }) => {
    mockStore((store, options) => {
      if (options.namespace === TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE) {
        throw new Error("history storage unavailable");
      }
      return store;
    });
    const cursor = cursorFor("failed-history");
    const opts = {
      ...sendOptions(),
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

  it.each([
    { name: "username target", to: "@fixture:topic:0", messageThreadId: undefined },
    { name: "numeric thread option", to: "-100123", messageThreadId: 0 },
  ])("rejects zero in $name before Telegram requests", async ({ to, messageThreadId }) => {
    fixture.responseFor = (method) =>
      method === "getChat"
        ? { id: -100123, type: "supergroup" }
        : providerMessage(-100123, "Must not send");
    const opts = { ...sendOptions(), messageThreadId };
    const error = /topic ID must be a positive safe integer/;
    await expect(sendMessageTelegram(to, "Must not send", opts)).rejects.toThrow(error);
    await expect(sendTypingTelegram(to, opts)).rejects.toThrow(error);
    expect(fixture.requests).toHaveLength(0);
  });

  it("records General-topic acceptance without inventing a private-chat General topic", async () => {
    fixture.responseFor = () => providerMessage(-100123, "Reply in General");
    await sendMessageTelegram("-100123:topic:1", "Reply in General", sendOptions());
    expect(fixture.requests[0]!.fields).not.toHaveProperty("message_thread_id");
    expect(hasProviderObservedTelegramThreadBinding(await getCached("902", "-100123"), 1)).toBe(
      true,
    );
    await sendTypingTelegram("-100123:topic:1", sendOptions());
    expect(fixture.requests[1]).toEqual({
      method: "sendChatAction",
      fields: { chat_id: "-100123", action: "typing", message_thread_id: 1 },
    });
    fixture.responseFor = () => providerMessage(123, "Private topic");
    await expect(
      sendMessageTelegram("123:topic:1", "Private topic", sendOptions()),
    ).rejects.toThrow("topic unknown; expected topic 1");
  });

  it("keeps Telegram time and transcript provenance for locations", async () => {
    fixture.responseFor = () => providerMessage(123, "Final answer");
    const cursor = cursorFor("assistant-final");
    const opts = {
      ...sendOptions(),
      promptContextProjectionPlan: { cursor, finalPart: true },
    };
    await sendLocationTelegram("123", { latitude: 48.858844, longitude: 2.294351 }, opts);
    const node = await getCached("902");
    expect(node?.timestamp).toBe(1_779_394_740_000);
    expect(node?.promptContextProjectionMarker).toEqual(projectionMarker("assistant-final"));
  });

  it("refreshes authoritative edited captions without hiding later group history", async () => {
    const original = providerMessage(-100123, "original response", { message_thread_id: 77 });
    fixture.responseFor = () => original;
    await sendMessageTelegram("-100123:topic:77", "original response", sendOptions());
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
      text: undefined,
      caption: "authoritative edited response",
      edit_date: 1_779_394_750,
    });
    await editMessageTelegram("-100123", 902, "requested replacement", {
      ...sendOptions(),
      editMode: "caption",
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
    expect(hasProviderObservedTelegramThreadBinding(await getCached("902", -100123), 77)).toBe(
      true,
    );
  });

  const emptyText = "Bad Request: text must be non-empty";
  const rejectedChunk = "Bad Request: chunk content rejected";
  const acceptedParts = ["A".repeat(4000), "A".repeat(1000)];
  it.each([
    [
      "html-recovery",
      ["2", "3"],
      ["Bad Request: can't parse entities"],
      ["<".repeat(1000), "y".repeat(3000)],
    ],
    ["middle-rejection", ["1", "3"], ["", rejectedChunk], acceptedParts],
    [
      "rich-recovery",
      ["2", "4"],
      ["Bad Request: RICH_MESSAGE_EMAIL_INVALID", "", rejectedChunk],
      acceptedParts,
    ],
    ["empty-tail", ["1"], ["", emptyText, emptyText], ["A".repeat(4000)]],
  ] as const)(
    "projects only accepted chunks through %s",
    async (outcome, ids, rejections, bodies) => {
      const cursor = cursorFor("multipart");
      fixture.responseFor = (method) =>
        method === "sendMessage"
          ? {
              message_id: fixture.requests.length,
              date: 1_779_394_740,
              chat: { id: 123, type: "private" },
            }
          : undefined;
      fixture.rejections.push(...rejections);
      const sending = sendMessageTelegram(
        "123",
        outcome === "html-recovery"
          ? "<".repeat(1000) + "y".repeat(3000)
          : outcome === "empty-tail"
            ? `${"A".repeat(4000)}\u200b\u200b`
            : "A".repeat(9000),
        {
          cfg: withPolicy({ richMessages: outcome === "rich-recovery" }),
          api: fixture.bot.api,
          ...(outcome === "rich-recovery" ? {} : { textMode: "html" as const }),
          buttons: fixture.buttons,
          promptContextProjectionPlan: { cursor, finalPart: true },
        },
      );
      const incomplete = outcome === "middle-rejection" || outcome === "rich-recovery";
      if (incomplete) {
        await expect(sending).rejects.toMatchObject({ deliveryResult: { messageIds: ids } });
      } else {
        await sending;
      }
      const nodes = await Promise.all(ids.map((messageId) => getCached(messageId)));
      expect(nodes.map((node) => node?.body)).toEqual(bodies);
      expect(nodes.map((node) => node?.promptContextProjectionMarker)).toEqual(
        ids.map((_, partIndex) =>
          projectionMarker("multipart", partIndex, !incomplete && partIndex === ids.length - 1),
        ),
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

  type PollScenario = {
    name: string;
    policy: TelegramAccountConfig;
    type: "private" | "supergroup" | "channel";
    status?: "administrator" | "member";
    thread?: number;
    warning?: string;
    scope?: { scope: "dm" | "forum" | "none"; id?: number };
  };
  const pollScenario = (
    name: string,
    warning?: string,
    overrides: Partial<PollScenario> = {},
  ): PollScenario => ({ name, warning, policy: {}, type: "supergroup", ...overrides });
  const disabled = "inbound messages are disabled";
  const topicPolicy = (topic: { enabled?: boolean; groupPolicy?: "disabled" }) => ({
    groups: { "-100123": { topics: { "77": topic } } },
  });
  it.each([
    pollScenario("DM topic", undefined, {
      type: "private",
      thread: 42,
      scope: { scope: "dm", id: 42 },
    }),
    pollScenario("group", undefined, { scope: { scope: "none" } }),
    pollScenario("General", undefined, { thread: 1, scope: { scope: "forum", id: 1 } }),
    pollScenario("anonymous", "anonymously"),
    pollScenario("channel", "Telegram channels", { type: "channel" }),
    pollScenario("non-admin", "not an administrator", { status: "member" }),
    pollScenario("account-disabled", disabled, { policy: { groupPolicy: "disabled" } }),
    pollScenario("group-disabled", disabled, {
      policy: { groups: { "-100123": { enabled: false } } },
    }),
    pollScenario("topic-disabled", disabled, {
      thread: 77,
      policy: topicPolicy({ enabled: false }),
    }),
    pollScenario("topic-policy", disabled, {
      thread: 77,
      policy: { groupPolicy: "open", ...topicPolicy({ groupPolicy: "disabled" }) },
    }),
    pollScenario("write-failure", "routing state could not be saved", { type: "private" }),
  ])("persists or warns for an accepted $name poll without resending", async (scenario) => {
    const chatId = scenario.type === "private" ? 123 : -100123;
    const thread = scenario.thread;
    fixture.responseFor = (method) =>
      method === "getChatMember"
        ? { status: scenario.status ?? "administrator" }
        : pollMessage(chatId, scenario.type, scenario.name, thread);
    if (scenario.name === "write-failure") {
      const state = getTelegramRuntime().state;
      const open = state.openKeyedStoreV2.bind(state);
      vi.spyOn(state, "openKeyedStoreV2").mockImplementation((options) => {
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
    const result = await sendPollTelegram(
      `${chatId}${thread ? `:topic:${thread}` : ""}`,
      { question: " Ready? ", options: [" Yes ", "No "] },
      {
        ...sendOptions(),
        cfg: withPolicy(scenario.policy),
        isAnonymous: scenario.name === "anonymous",
      },
    );
    expect(result).toMatchObject({
      messageId: "500",
      pollAnswerRouting: scenario.warning ? "unavailable" : "enabled",
      ...(scenario.warning ? { warning: expect.stringContaining(scenario.warning) } : {}),
    });
    const entry = await findTelegramPollRegistryEntry({ pollId: scenario.name });
    if (scenario.warning) {
      expect(entry).toBeNull();
    } else {
      expect(entry).toMatchObject({
        messageId: 500,
        threadSpec: scenario.scope,
        question: "Ready?",
        options: ["Yes", "No"],
      });
    }
    expect(fixture.requests.map(({ method }) => method)).toEqual(
      chatId < 0 && (!scenario.warning || scenario.name === "non-admin")
        ? ["sendPoll", "getChatMember"]
        : ["sendPoll"],
    );
  });

  it("shares cold hydration while waiting for durable ownership persistence", async () => {
    const hydration = createDeferred<never[]>();
    const persistence = createDeferred<void>();
    const entries = vi.fn(() => hydration.promise);
    mockStore((store) => ({
      ...store,
      entries,
      register: () => persistence.promise,
    }));
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
    const writes: Array<[unknown, number | undefined]> = [];
    mockStore((store) => {
      return {
        ...store,
        register: async (key, value, registration) => {
          await store.register(key, value, registration);
          writes.push([value, registration?.ttlMs]);
        },
      };
    });
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
    mockStore((store) => ({
      ...store,
      entries: async () => {
        throw new Error("read unavailable");
      },
      register: async () => {
        throw new Error("write unavailable");
      },
    }));
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
