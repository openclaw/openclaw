import {
  AsyncWorkScope,
  createDeferred,
  getAsyncWorkSignal,
} from "openclaw/plugin-sdk/concurrency-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchWithContext,
  dispatchReplyWithBufferedBlockDispatcher,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import {
  getTopicName,
  getTopicLabelMetadata,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

const topicContext = (RawBody: string, ThreadLabel: string, accountId = "default", extra = {}) =>
  createContext({
    accountId,
    ctxPayload: { ...createContext().ctxPayload, RawBody, ThreadLabel, ...extra },
  });

describeTelegramDispatch("DM topic label recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  const http = useTelegramHttpFixture();
  it("names from the first real message after a command, outside the closed turn scope", async ({
    signal,
  }) => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    generateTopicLabel.mockImplementation(async () => {
      await new Promise(setImmediate);
      getAsyncWorkSignal()?.throwIfAborted();
      return "Invoice review";
    });
    const named = createDeferred();
    const cache = await import("./topic-name-cache.js");
    const persistName = cache.updateTopicName;
    vi.spyOn(cache, "updateTopicName").mockImplementation(async (...args) => {
      await persistName(...args);
      if (args[2].name === "Invoice review") {
        named.resolve();
      }
    });
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const command = topicContext("/model", "New Thread", "default", { CommandSource: "text" });
    await dispatchWithContext({ context: command, bot, streamMode: "off" });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    const turn = new AsyncWorkScope();
    const real = topicContext("/tmp/report.csv summarize", "New Thread");
    await turn.track(() => dispatchWithContext({ context: real, bot, streamMode: "off" }));
    await turn.drain();
    await withinTest(named.promise, signal);
    expect(edit).toHaveBeenCalledWith(123, 777, { name: "Invoice review" });
  });

  beforeEach(async () => {
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    const base = createContext();
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath: base.turn.storePath,
      sessionKey: base.ctxPayload.SessionKey!,
      fallbackEntry: { sessionId: "s1", updatedAt: 1 },
      prepare: () => ({ sessionId: "s1" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "s1", systemSent: false });
  });

  it("preserves an explicit topic edit made while naming is in flight", async () => {
    const cfg = {
      ...http.cfg,
      channels: {
        telegram: {
          ...http.cfg.channels.telegram,
          accounts: { alerts: { botToken: "654321:topic-recovery-fixture" } },
          actions: { editForumTopic: true },
        },
      },
    };
    const base = createContext();
    const scope = resolveTelegramDirectTopicNameCacheScope(base.turn.storePath, "alerts");
    await updateTopicName(123, 777, { name: "New Thread" }, scope);
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Invoice details" }, { kind: "final" });
      return { queuedFinal: true };
    });
    let finishLabel!: (name: string) => void;
    generateTopicLabel.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishLabel = resolve;
        }),
    );
    await dispatchWithContext({
      context: createContext({
        accountId: "alerts",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Review an invoice",
          ThreadLabel: "New Thread",
          MessageSid: "1",
        },
      }),
      cfg,
      bot,
      streamMode: "off",
    });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledOnce());
    const { handleTelegramAction } = await import("./action-runtime.js");
    await handleTelegramAction(
      {
        action: "topic-edit",
        chatId: "123",
        threadId: 777,
        name: "Manual invoice title",
        accountId: "alerts",
      },
      cfg,
    );
    finishLabel("Outdated title");
    await vi.waitFor(() => expect(generateTopicLabel).toHaveResolved());
    // Allow the detached continuation to run its metadata check after inference settles.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(http.requests).toEqual([
      {
        method: "editForumTopic",
        fields: { chat_id: "123", message_thread_id: 777, name: "Manual invoice title" },
      },
    ]);
    expect(await getTopicName(123, 777, scope)).toBe("Manual invoice title");
    expect(edit).not.toHaveBeenCalled();
  });

  it("keeps a topic edited during the reply after earlier labeling failed", async ({ signal }) => {
    const cfg = {
      ...http.cfg,
      channels: {
        telegram: {
          ...http.cfg.channels.telegram,
          accounts: { alerts: { botToken: "654321:topic-recovery-fixture" } },
          actions: { editForumTopic: true },
        },
      },
    };
    const scope = resolveTelegramDirectTopicNameCacheScope(
      createContext().turn.storePath,
      "alerts",
    );
    await updateTopicName(123, 777, { name: "New Thread" }, scope);
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const context = () => topicContext("Review an invoice", "New Thread", "alerts");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Invoice details" }, { kind: "final" });
      return { queuedFinal: true };
    });
    generateTopicLabel.mockResolvedValueOnce(null).mockResolvedValue("Invoice review");
    await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
    mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
    const started = createDeferred();
    const release = createDeferred<string>();
    const staleRead = createDeferred();
    const cache = await import("./topic-name-cache.js");
    const readMetadata = cache.getTopicLabelMetadata;
    let released = false;
    vi.spyOn(cache, "getTopicLabelMetadata").mockImplementation(async (...args) => {
      const result = await readMetadata(...args);
      if (released) {
        staleRead.resolve();
      }
      return result;
    });
    generateTopicLabel.mockImplementationOnce(async () => {
      started.resolve();
      return await release.promise;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await withinTest(started.promise, signal);
        const { handleTelegramAction } = await import("./action-runtime.js");
        await handleTelegramAction(
          {
            action: "topic-edit",
            chatId: "123",
            threadId: 777,
            name: "Manual invoice title",
            accountId: "alerts",
          },
          cfg,
        );
        released = true;
        release.resolve("Outdated title");
        await dispatcherOptions.deliver({ text: "Renamed the topic" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    try {
      await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
      await withinTest(staleRead.promise, signal);
    } finally {
      release.resolve("Outdated title");
    }
    expect(generateTopicLabel).toHaveBeenCalledTimes(2);
    expect(http.requests).toEqual([
      {
        method: "editForumTopic",
        fields: { chat_id: "123", message_thread_id: 777, name: "Manual invoice title" },
      },
    ]);
    expect(await getTopicName(123, 777, scope)).toBe("Manual invoice title");
    expect(edit).not.toHaveBeenCalled();
  });

  it.each(["empty", "model error", "Telegram error"])(
    "retries after %s even when the reply has already completed",
    async (failure) => {
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Invoice details" }, { kind: "final" });
        return { queuedFinal: true };
      });
      const generate = generateTopicLabel;
      generate.mockImplementationOnce(async () => {
        if (failure === "model error") {
          throw new Error("model unavailable");
        }
        return failure === "empty" ? null : "Invoice review";
      });
      generate.mockResolvedValue("Invoice review");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      if (failure === "Telegram error") {
        edit.mockRejectedValueOnce(new Error("edit unavailable"));
      }
      const scope = resolveTelegramDirectTopicNameCacheScope(
        createContext().turn.storePath,
        "default",
      );
      await updateTopicName(123, 777, { name: "Auto preview...", isNameImplicit: true }, scope);
      let messageId = 0;
      const context = () =>
        createContext({
          accountId: "default",
          ctxPayload: {
            ...createContext().ctxPayload,
            RawBody: "Review an invoice",
            ThreadLabel: "Auto preview...",
            MessageSid: String(++messageId),
          },
        });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      if (failure === "Telegram error") {
        await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      }
      expect((await getTopicLabelMetadata(123, 777, scope))?.isNameImplicit).toBe(true);
      mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      await vi.waitFor(
        async () => expect(await getTopicName(123, 777, scope)).toBe("Invoice review"),
        { timeout: 20_000 },
      );
      expect((await getTopicLabelMetadata(123, 777, scope))?.isNameImplicit).toBeUndefined();
      await dispatchWithContext({
        context: createContext({
          accountId: "default",
          ctxPayload: {
            ...createContext().ctxPayload,
            RawBody: "Check the total",
            ThreadLabel: "Invoice review",
          },
        }),
        bot,
        streamMode: "off",
      });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenLastCalledWith(123, 777, { name: "Invoice review" });
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      const base = createContext();
      await sdk.prepareSessionEntryPatch({
        agentId: "default",
        storePath: base.turn.storePath,
        sessionKey: base.ctxPayload.SessionKey!,
        prepare: () => ({
          sessionId: "s2",
          topicName: "Invoice review",
          displayName: "Invoice review",
        }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      mockDefaultSessionEntry({ sessionId: "s2", systemSent: true });
      await dispatchWithContext({
        context: createContext({
          accountId: "default",
          ctxPayload: {
            ...base.ctxPayload,
            RawBody: "Continue invoice",
            ThreadLabel: "Invoice review",
            MessageSid: "4",
          },
        }),
        bot,
        streamMode: "off",
      });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
      expect(generate.mock.calls[2]?.[0].prompt).toContain("Invoice review");
    },
  );
});
