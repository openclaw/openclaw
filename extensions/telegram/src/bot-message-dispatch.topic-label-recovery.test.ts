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

describeTelegramDispatch("DM topic label recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  const http = useTelegramHttpFixture();
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
    const context = () =>
      createContext({
        accountId: "alerts",
        ctxPayload: {
          ...createContext().ctxPayload,
          RawBody: "Review an invoice",
          ThreadLabel: "New Thread",
        },
      });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Invoice details" }, { kind: "final" });
      return { queuedFinal: true };
    });
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
      await updateTopicName(123, 777, { name: "New Thread" }, scope);
      const context = () =>
        createContext({
          accountId: "default",
          ctxPayload: {
            ...createContext().ctxPayload,
            RawBody: "Review an invoice",
            ThreadLabel: "New Thread",
          },
        });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      if (failure === "Telegram error") {
        await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
      }
      mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
      await dispatchWithContext({ context: context(), bot, streamMode: "off" });
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () =>
        expect(await getTopicName(123, 777, scope)).toBe("Invoice review"),
      );
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
    },
  );
});
