import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
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
  getTopicLabelState,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

describeTelegramDispatch("DM topic label recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  const http = useTelegramHttpFixture();
  async function seedNamingEntry(sessionId = "s1") {
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    const context = createContext();
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath: context.turn.storePath,
      sessionKey: context.ctxPayload.SessionKey!,
      fallbackEntry: { sessionId, updatedAt: 1 },
      prepare: () => ({ sessionId, displayName: "Existing topic" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
  }
  beforeEach(() => seedNamingEntry());
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

  it("keeps reset topic naming pending across a /model control command", async () => {
    await seedNamingEntry("reset-session");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Model changed" }, { kind: "final" });
      return { queuedFinal: true };
    });
    mockDefaultSessionEntry({ sessionId: "reset-session", systemSent: false });
    const scope = resolveTelegramDirectTopicNameCacheScope(
      createContext().turn.storePath,
      "default",
    );
    await updateTopicName(123, 777, { name: "Existing topic" }, scope);
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ...createContext().ctxPayload,
          RawBody: "/model provider/test-model",
          BodyForAgent: "/model provider/test-model",
          ThreadLabel: "Existing topic",
        },
      }),
      bot,
      streamMode: "off",
    });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();

    mockDefaultSessionEntry({ sessionId: "reset-session", systemSent: true });
    generateTopicLabel.mockResolvedValueOnce("KEEP");
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Invoice follow-up" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ...createContext().ctxPayload,
          RawBody: "Continue reviewing the invoice",
          BodyForAgent: "Continue reviewing the invoice",
          ThreadLabel: "Existing topic",
        },
      }),
      bot,
      streamMode: "off",
    });
    await vi.waitFor(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
    expect(generateTopicLabel).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "Continue reviewing the invoice" }),
    );
    await vi.waitFor(async () =>
      expect((await getTopicLabelState(123, 777, scope))?.labelPending).toBe(false),
    );
    expect(await getTopicName(123, 777, scope)).toBe("Existing topic");
    expect(edit).not.toHaveBeenCalled();
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    expect(
      await sdk.getSessionEntryAsync({
        agentId: "default",
        storePath: createContext().turn.storePath,
        sessionKey: createContext().ctxPayload.SessionKey!,
      }),
    ).toMatchObject({ topicName: "Existing topic", displayName: "Existing topic" });
  });

  it.each([
    {
      response: "REPLACE: Travel planning",
      manual: false,
      duringGeneration: false,
      expected: "Travel planning",
    },
    {
      response: "REPLACE: Travel planning",
      manual: true,
      duringGeneration: false,
      expected: "Invoice review",
    },
    {
      response: "REPLACE: Travel planning",
      manual: false,
      duringGeneration: true,
      expected: "Invoice review",
    },
  ])(
    "reassesses a reset topic while preserving manual names ($manual)",
    async ({ response, manual, duringGeneration, expected }) => {
      const scope = resolveTelegramDirectTopicNameCacheScope(
        createContext().turn.storePath,
        "default",
      );
      await updateTopicName(
        123,
        777,
        { name: "Invoice review", nameSource: manual ? "manual" : "generated" },
        scope,
      );
      mockDefaultSessionEntry({ sessionId: "s1", systemSent: false });
      const skipLog = vi.spyOn(runtimeEnv, "logVerbose");
      generateTopicLabel.mockImplementation(async () => {
        if (duringGeneration) {
          await updateTopicName(123, 777, { name: "Invoice review", nameSource: "manual" }, scope);
        }
        return response;
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Working on the task" }, { kind: "final" });
        return { queuedFinal: true };
      });
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      await dispatchWithContext({
        context: createContext({
          ctxPayload: {
            ...createContext().ctxPayload,
            RawBody: "Plan a holiday in Lisbon",
            ThreadLabel: "Invoice review",
          },
        }),
        bot,
        streamMode: "off",
      });
      if (manual || duringGeneration) {
        if (duringGeneration) {
          await vi.waitFor(() =>
            expect(skipLog).toHaveBeenCalledWith(
              "auto-topic-label: topic name changed, skipping rename",
            ),
          );
        } else {
          expect(generateTopicLabel).not.toHaveBeenCalled();
        }
        expect(edit).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(edit).toHaveBeenCalledWith(123, 777, { name: expected }));
        await vi.waitFor(async () =>
          expect((await getTopicLabelState(123, 777, scope))?.labelPending).toBe(false),
        );
      }
      expect(await getTopicName(123, 777, scope)).toBe(expected);
    },
  );

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
