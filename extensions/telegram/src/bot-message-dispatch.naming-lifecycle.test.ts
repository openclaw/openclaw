import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";
import {
  getTopicLabelMetadata,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

// Allow detached SQLite work to settle on slow test hosts.
function waitForNaming<T>(check: () => T | Promise<T>) {
  return vi.waitFor(check, { timeout: 20_000 });
}

function mockSuccessfulReply() {
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
    return { queuedFinal: true };
  });
}

describeTelegramDispatch("Telegram topic naming lifecycle", () => {
  beforeEach(async () => {
    await captureRuntimeConfigAsyncReader()();
  });
  afterEach(() => vi.restoreAllMocks());
  it.each(["cached", "legacy"] as const)(
    "keeps a manual name through reset and commands (%s)",
    async (cacheKind) => {
      const initial = createContext();
      const sessionKey = initial.ctxPayload.SessionKey!;
      const storePath = initial.turn.storePath;
      const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      await sdk.prepareSessionEntryPatch({
        agentId: "default",
        storePath,
        sessionKey,
        fallbackEntry: { sessionId: "same-session", lifecycleRevision: "after", updatedAt: 1 },
        prepare: () => ({ sessionId: "same-session", label: "Email", topicName: "Email" }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      mockDefaultSessionEntry({
        sessionId: "same-session",
        lifecycleRevision: "after",
        label: "Email",
        topicName: "Email",
        systemSent: true,
      });
      await updateTopicName(
        123,
        777,
        {
          name: "Email",
          labelState:
            cacheKind === "cached"
              ? {
                  sessionId: "same-session",
                  lifecycleRevision: "before",
                  remainingMessages: 2,
                  lastMessageId: "8",
                }
              : undefined,
        },
        scope,
      );
      mockSuccessfulReply();
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      const turn = (body: string, id: number, command = false) =>
        createContext({
          accountId: "default",
          ctxPayload: {
            ...initial.ctxPayload,
            RawBody: body,
            ThreadLabel: "Email",
            MessageSid: String(id),
            ...(command ? { CommandSource: "text" as const } : {}),
          },
        });
      const resetReader =
        cacheKind === "legacy"
          ? vi
              .spyOn(
                await import("openclaw/plugin-sdk/reply-dispatch-runtime"),
                "readConversationLabelResetState",
              )
              .mockResolvedValueOnce({
                sessionId: "same-session",
                lifecycleRevision: "before",
                remainingMessages: 0,
              })
          : undefined;
      await dispatchWithContext({ context: turn("/model test", 9, true), bot, streamMode: "off" });
      expect(generateTopicLabel).not.toHaveBeenCalled();
      if (cacheKind === "cached") {
        expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
          sessionId: "same-session",
          lifecycleRevision: "before",
        });
      } else {
        expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toBeUndefined();
        expect(resetReader).not.toHaveBeenCalled();
      }
      generateTopicLabel.mockResolvedValueOnce("Email");
      await dispatchWithContext({
        context: turn("Check the mail monitor", 10),
        bot,
        streamMode: "off",
      });
      await waitForNaming(async () =>
        expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
          sessionId: "same-session",
          lifecycleRevision: "after",
          remainingMessages: 6,
          lastMessageId: "10",
        }),
      );
      expect(generateTopicLabel).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining('"Email"') }),
      );
      expect(edit).not.toHaveBeenCalled();
    },
  );
  it("counts six distinct follow-up tasks and reassesses the current manual title", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      fallbackEntry: { sessionId: "current", updatedAt: 1 },
      prepare: () => ({ sessionId: "current", label: "Manual title", topicName: "Manual title" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({
      sessionId: "current",
      label: "Manual title",
      topicName: "Manual title",
      systemSent: true,
    });
    await updateTopicName(
      123,
      777,
      {
        name: "Manual title",
        labelState: {
          sessionId: "current",
          remainingMessages: 6,
          lastMessageId: "1",
        },
      },
      scope,
    );
    mockSuccessfulReply();
    const bot = createBot();
    for (let id = 2; id <= 6; id++) {
      await dispatchWithContext({
        context: createContext({
          accountId: "default",
          ctxPayload: {
            ...base.ctxPayload,
            RawBody: `Continue task ${id}`,
            ThreadLabel: "Manual title",
            MessageSid: String(id),
          },
        }),
        bot,
        streamMode: "off",
      });
    }
    expect(generateTopicLabel).not.toHaveBeenCalled();
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.remainingMessages).toBe(1),
    );
    generateTopicLabel.mockResolvedValueOnce("Manual title");
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Continue task 7",
          ThreadLabel: "Manual title",
          MessageSid: "7",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledOnce());
    expect(generateTopicLabel).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('"Manual title"') }),
    );
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.remainingMessages).toBe(0),
    );
  });
  it("settles the reset lifecycle when Telegram echoes the bot's own new topic name", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      fallbackEntry: { sessionId: "new", updatedAt: 1 },
      prepare: () => ({ sessionId: "new", topicName: "Email" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "new", topicName: "Email", systemSent: true });
    await updateTopicName(
      123,
      777,
      {
        name: "Email",
        labelState: { sessionId: "old", remainingMessages: 3 },
      },
      scope,
    );
    mockSuccessfulReply();
    generateTopicLabel.mockResolvedValueOnce("Lisbon trip");
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    edit.mockImplementationOnce(async () => {
      await updateTopicName(123, 777, { name: "Lisbon trip" }, scope);
      await sdk.prepareSessionEntryPatch({
        agentId: "default",
        storePath,
        sessionKey,
        prepare: () => ({ topicName: "Lisbon trip" }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      return true;
    });
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Plan a Lisbon trip",
          ThreadLabel: "Email",
          MessageSid: "12",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        sessionId: "new",
        remainingMessages: 6,
      }),
    );
  });
  it("names a new topic when placeholder displayName is set during inference", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    const target = { agentId: "default", storePath, sessionKey };
    await sdk.prepareSessionEntryPatch({
      ...target,
      fallbackEntry: { sessionId: "placeholder-race", updatedAt: 1 },
      prepare: () => ({
        sessionId: "placeholder-race",
        topicName: "New Chat",
      }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "placeholder-race", systemSent: false });
    let release!: (name: string) => void;
    const generated = new Promise<string>((resolve) => {
      release = resolve;
    });
    generateTopicLabel.mockImplementationOnce(async () => await generated);
    mockSuccessfulReply();
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const pending = dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Review invoice",
          ThreadLabel: "New Chat",
          MessageSid: "1",
        },
      }),
      bot,
      streamMode: "off",
    });
    try {
      await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
      await sdk.prepareSessionEntryPatch({
        ...target,
        prepare: () => ({ displayName: "New Chat" }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      release("Invoice review");
      await pending;
      await waitForNaming(async () =>
        expect((await getTopicLabelMetadata(123, 777, scope))?.name).toBe("Invoice review"),
      );
      expect(edit).toHaveBeenCalledWith(123, 777, { name: "Invoice review" });
      await waitForNaming(async () =>
        expect(
          await sdk.getSessionEntryAsync({ ...target, readConsistency: "latest" }),
        ).toMatchObject({
          topicName: "Invoice review",
          displayName: "Invoice review",
        }),
      );
    } finally {
      release("Invoice review");
      await pending;
    }
  });
  it("reassesses when the opening batch already contains six follow-ups", async () => {
    const base = createContext();
    const scope = resolveTelegramDirectTopicNameCacheScope(base.turn.storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath: base.turn.storePath,
      sessionKey: base.ctxPayload.SessionKey!,
      fallbackEntry: { sessionId: "opening-batch", updatedAt: 1 },
      prepare: () => ({ sessionId: "opening-batch", topicName: "New Chat" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "opening-batch", systemSent: false });
    generateTopicLabel.mockResolvedValueOnce("Initial").mockResolvedValueOnce("Refined");
    mockSuccessfulReply();
    const bot = createBot();
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Seven related tasks",
          ThreadLabel: "New Chat",
          MessageSid: "7",
          MessageSids: ["1", "2", "3", "4", "5", "6", "7"],
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.name).toBe("Refined"),
    );
    expect(generateTopicLabel).toHaveBeenCalledTimes(2);
    expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
      remainingMessages: 0,
      lastMessageId: "7",
    });
  });
  it.each(["implicit", "observed", "explicit", "edited"] as const)(
    "respects %s creation provenance while the first reply is held",
    async (kind) => {
      const base = createContext();
      const scope = resolveTelegramDirectTopicNameCacheScope(base.turn.storePath, "default");
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      const title = "Скачай через дан...";
      await sdk.prepareSessionEntryPatch({
        agentId: "default",
        storePath: base.turn.storePath,
        sessionKey: base.ctxPayload.SessionKey!,
        fallbackEntry: { sessionId: "implicit-first", updatedAt: 1 },
        prepare: () => ({ sessionId: "implicit-first", topicName: title, displayName: title }),
        authority: { kind: "host", assertCurrent() {} },
        requireWriteSuccess: true,
      });
      const { resolveTelegramForumTopicMetadata } = await import("./forum-topic-metadata.js");
      await resolveTelegramForumTopicMetadata({
        msg: {
          message_id: 777,
          date: 1,
          chat: { id: 123, type: "private", first_name: "Tester" },
          forum_topic_created: {
            name: title,
            icon_color: 0,
            ...(kind !== "explicit" ? { is_name_implicit: true as const } : {}),
          },
        },
        threadId: 777,
        scope,
      });
      if (kind === "edited") {
        await updateTopicName(123, 777, { name: title }, scope);
      } else if (kind === "observed") {
        await updateTopicName(
          123,
          777,
          {
            labelState: {
              sessionId: "implicit-first",
              remainingMessages: 2,
              lastMessageId: "earlier",
            },
          },
          scope,
        );
      }
      mockDefaultSessionEntry({ sessionId: "implicit-first", systemSent: false });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await gate;
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      generateTopicLabel.mockResolvedValue("Invoice review");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      const pending = dispatchWithContext({
        context: createContext({
          accountId: "default",
          ctxPayload: {
            ...base.ctxPayload,
            RawBody: "Review invoice",
            ThreadLabel: title,
            MessageSid: "1",
          },
        }),
        bot,
        streamMode: "off",
      });
      try {
        if (kind === "implicit" || kind === "observed") {
          await waitForNaming(async () =>
            expect((await getTopicLabelMetadata(123, 777, scope))?.name).toBe("Invoice review"),
          );
          expect(edit).toHaveBeenCalledWith(123, 777, { name: "Invoice review" });
          expect(generateTopicLabel).toHaveBeenCalledWith(
            expect.objectContaining({ userMessage: "Review invoice" }),
          );
        } else {
          await waitForNaming(async () =>
            expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.lastMessageId).toBe(
              "1",
            ),
          );
          expect(generateTopicLabel).not.toHaveBeenCalled();
          expect(edit).not.toHaveBeenCalled();
        }
      } finally {
        release();
        await pending;
      }
    },
  );
  it("counts every message in a coalesced follow-up and ignores a retry", async () => {
    const base = createContext();
    const scope = resolveTelegramDirectTopicNameCacheScope(base.turn.storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath: base.turn.storePath,
      sessionKey: base.ctxPayload.SessionKey!,
      fallbackEntry: { sessionId: "batch", updatedAt: 1 },
      prepare: () => ({ sessionId: "batch", topicName: "Existing" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "batch", systemSent: true });
    await updateTopicName(
      123,
      777,
      {
        name: "Existing",
        labelState: { sessionId: "batch", remainingMessages: 3, lastMessageId: "1" },
      },
      scope,
    );
    generateTopicLabel.mockResolvedValueOnce("Existing");
    mockSuccessfulReply();
    const bot = createBot();
    const context = createContext({
      accountId: "default",
      ctxPayload: {
        ...base.ctxPayload,
        RawBody: "More tasks",
        ThreadLabel: "Existing",
        MessageSid: "2",
        MessageSids: ["2", "3", "4"],
      },
    });
    await dispatchWithContext({ context, bot, streamMode: "off" });
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        remainingMessages: 0,
        lastMessageId: "4",
      }),
    );
    await dispatchWithContext({ context, bot, streamMode: "off" });
    await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledTimes(1));
  });
  it("does not overwrite an explicit same-name edit made while inference is running", async () => {
    const base = createContext();
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey: base.ctxPayload.SessionKey!,
      fallbackEntry: { sessionId: "new", updatedAt: 1 },
      prepare: () => ({ sessionId: "new", topicName: "Email" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "new", topicName: "Email", systemSent: true });
    await updateTopicName(
      123,
      777,
      {
        name: "Email",
        labelState: { sessionId: "old", remainingMessages: 0 },
      },
      scope,
    );
    mockSuccessfulReply();
    const skipLog = vi.spyOn(runtimeEnv, "logVerbose");
    let release!: (value: string) => void;
    generateTopicLabel.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Plan a trip",
          ThreadLabel: "Email",
          MessageSid: "18",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledOnce());
    await updateTopicName(123, 777, { name: "Email" }, scope);
    release("Lisbon trip");
    await waitForNaming(() =>
      expect(skipLog).toHaveBeenCalledWith("auto-topic-label: stale naming result skipped"),
    );
    expect(edit).not.toHaveBeenCalled();
    expect((await getTopicLabelMetadata(123, 777, scope))?.name).toBe("Email");
  });
  it("compares the Telegram-renamed topic rather than a stale automatic display name", async () => {
    const base = createContext();
    const storePath = base.turn.storePath;
    const sessionKey = base.ctxPayload.SessionKey!;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      fallbackEntry: { sessionId: "new", updatedAt: 1 },
      prepare: () => ({ sessionId: "new", displayName: "Old automatic title", topicName: "Email" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({
      sessionId: "new",
      displayName: "Old automatic title",
      topicName: "Email",
      systemSent: true,
    });
    await updateTopicName(
      123,
      777,
      { name: "Email", labelState: { sessionId: "old", remainingMessages: 0 } },
      scope,
    );
    mockSuccessfulReply();
    generateTopicLabel.mockResolvedValueOnce("Email");
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Check the mail",
          ThreadLabel: "Email",
          MessageSid: "19",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() =>
      expect(generateTopicLabel).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining('"Email"') }),
      ),
    );
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState?.sessionId).toBe("new"),
    );
    expect(edit).not.toHaveBeenCalled();
  });
  it("counts distinct follow-ups received while the initial title is still generating", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      fallbackEntry: { sessionId: "first", updatedAt: 1 },
      prepare: () => ({ sessionId: "first" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "first", systemSent: false });
    mockSuccessfulReply();
    let finish!: (title: string) => void;
    generateTopicLabel.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const bot = createBot();
    const turn = (text: string, id: number) =>
      createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: text,
          ThreadLabel: "New Thread",
          MessageSid: String(id),
        },
      });
    await dispatchWithContext({ context: turn("Review invoice", 1), bot, streamMode: "off" });
    await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledOnce());
    await dispatchWithContext({ context: turn("Review the total", 2), bot, streamMode: "off" });
    await dispatchWithContext({ context: turn("Review the deadline", 3), bot, streamMode: "off" });
    expect(generateTopicLabel).toHaveBeenCalledOnce();
    finish("Invoice review");
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        sessionId: "first",
        remainingMessages: 4,
        lastMessageId: "3",
      }),
    );
    expect(generateTopicLabel).toHaveBeenCalledOnce();
  });
  it("does not apply queued messages from before a reset that keeps the session ID", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      fallbackEntry: { sessionId: "same", lifecycleRevision: "before", updatedAt: 1 },
      prepare: () => ({ topicName: "Email" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "same", lifecycleRevision: "before", topicName: "Email" });
    await updateTopicName(
      123,
      777,
      {
        name: "Email",
        labelState: { sessionId: "same", lifecycleRevision: "before", remainingMessages: 1 },
      },
      scope,
    );
    mockSuccessfulReply();
    let finish!: (title: string) => void;
    generateTopicLabel.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    generateTopicLabel.mockResolvedValue("Email");
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    const turn = (text: string, id: number) =>
      createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: text,
          ThreadLabel: "Email",
          MessageSid: String(id),
        },
      });
    await dispatchWithContext({
      context: turn("Review the old mail task", 1),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() => expect(generateTopicLabel).toHaveBeenCalledOnce());
    await dispatchWithContext({ context: turn("Queued before reset", 2), bot, streamMode: "off" });
    await sdk.prepareSessionEntryPatch({
      agentId: "default",
      storePath,
      sessionKey,
      prepare: () => ({ lifecycleRevision: "after" }),
      authority: { kind: "host", assertCurrent() {} },
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "same", lifecycleRevision: "after", topicName: "Email" });
    await dispatchWithContext({
      context: turn("Review the current mail task", 3),
      bot,
      streamMode: "off",
    });
    finish("Obsolete result");
    await waitForNaming(async () =>
      expect((await getTopicLabelMetadata(123, 777, scope))?.labelState).toMatchObject({
        sessionId: "same",
        lifecycleRevision: "after",
        lastMessageId: "3",
        remainingMessages: 6,
      }),
    );
    expect(generateTopicLabel).toHaveBeenCalledTimes(2);
    expect(generateTopicLabel).toHaveBeenLastCalledWith(
      expect.objectContaining({ userMessage: "Review the current mail task" }),
    );
    expect(edit).not.toHaveBeenCalled();
  });
});
