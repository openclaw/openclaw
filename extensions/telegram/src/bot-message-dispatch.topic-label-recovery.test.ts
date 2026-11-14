import { AsyncWorkScope, getAsyncWorkSignal } from "openclaw/plugin-sdk/concurrency-runtime";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, expect, it, vi } from "vitest";
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
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

const topicContext = (RawBody: string, ThreadLabel: string, accountId = "default", extra = {}) =>
  createContext({
    accountId,
    ctxPayload: { ...createContext().ctxPayload, RawBody, ThreadLabel, ...extra },
  });
const replyWith = (text: string) =>
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text }, { kind: "final" });
    return { queuedFinal: true };
  });

describeTelegramDispatch("DM topic label recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  const http = useTelegramHttpFixture();
  it("names from the first real message after a command, outside the closed turn scope", async () => {
    replyWith("Done");
    generateTopicLabel.mockImplementation(async () => {
      await new Promise(setImmediate);
      getAsyncWorkSignal()?.throwIfAborted();
      return "Invoice review";
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
    await vi.waitFor(() => expect(edit).toHaveBeenCalledWith(123, 777, { name: "Invoice review" }));
  });
  it("preserves an explicit topic-edit after failed labeling without a service-message echo", async () => {
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
    replyWith("Invoice details");
    generateTopicLabel.mockResolvedValueOnce(null).mockResolvedValue("Invoice review");
    await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
    mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
    const skipLog = vi.spyOn(runtimeEnv, "logVerbose");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
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
        await dispatcherOptions.deliver({ text: "Renamed the topic" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    await dispatchWithContext({ context: context(), cfg, bot, streamMode: "off" });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(skipLog).toHaveBeenCalledWith("auto-topic-label: topic name changed, skipping rename"),
    );
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
      replyWith("Invoice details");
      generateTopicLabel.mockImplementationOnce(async () => {
        if (failure === "model error") {
          throw new Error("model unavailable");
        }
        return failure === "empty" ? null : "Invoice review";
      });
      generateTopicLabel.mockResolvedValue("Invoice review");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      if (failure === "Telegram error") {
        edit.mockRejectedValueOnce(new Error("edit unavailable"));
      }
      const scope = resolveTelegramDirectTopicNameCacheScope(
        createContext().turn.storePath,
        "default",
      );
      await updateTopicName(123, 777, { name: "New Thread" }, scope);
      const context = () => topicContext("Review an invoice", "New Thread");
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
      if (failure === "Telegram error") {
        await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
      }
      mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () =>
        expect(await getTopicName(123, 777, scope)).toBe("Invoice review"),
      );
      const context2 = topicContext("Check the total", "Invoice review");
      await dispatchWithContext({ context: context2, bot, streamMode: "off" });
      expect(generateTopicLabel).toHaveBeenCalledTimes(2);
      expect(edit).toHaveBeenLastCalledWith(123, 777, { name: "Invoice review" });
    },
  );
});
