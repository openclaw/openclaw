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

function waitForNaming<T>(check: () => T | Promise<T>) {
  return vi.waitFor(check, { timeout: 20_000 });
}

describeTelegramDispatch("Telegram topic label ownership", () => {
  beforeEach(async () => {
    await captureRuntimeConfigAsyncReader()();
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([true, false])(
    "claims the generated label only when available (occupied=%s)",
    async (occupied) => {
      const base = createContext();
      const sessionKey = base.ctxPayload.SessionKey!;
      const storePath = base.turn.storePath;
      const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      const target = { agentId: "default", storePath, sessionKey };
      const authority = { kind: "host" as const, assertCurrent() {} };
      await sdk.prepareSessionEntryPatch({
        ...target,
        fallbackEntry: { sessionId: "new", updatedAt: 1 },
        prepare: () => ({ sessionId: "new", label: "Email", topicName: "Email" }),
        authority,
        requireWriteSuccess: true,
      });
      if (occupied) {
        await sdk.prepareSessionEntryPatch({
          ...target,
          sessionKey: "agent:default:other",
          fallbackEntry: { sessionId: "other", updatedAt: 1 },
          prepare: () => ({ label: "Lisbon trip" }),
          authority,
          requireWriteSuccess: true,
        });
      }
      mockDefaultSessionEntry({
        sessionId: "new",
        label: "Email",
        topicName: "Email",
        systemSent: true,
      });
      await updateTopicName(
        123,
        777,
        { name: "Email", labelState: { sessionId: "old", remainingMessages: 0 } },
        scope,
      );
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      const log = vi.spyOn(runtimeEnv, "logVerbose");
      generateTopicLabel.mockResolvedValueOnce("Lisbon trip");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
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
      if (occupied) {
        await waitForNaming(() =>
          expect(
            log.mock.calls.some(([message]) => message.includes("label is already in use")) ||
              edit.mock.calls.length > 0,
          ).toBe(true),
        );
        expect(log).toHaveBeenCalledWith(expect.stringContaining("label is already in use"));
        expect(edit).not.toHaveBeenCalled();
        expect((await sdk.getSessionEntryAsync(target))?.label).toBe("Email");
      } else {
        await waitForNaming(() =>
          expect(edit).toHaveBeenCalledWith(123, 777, { name: "Lisbon trip" }),
        );
        expect((await sdk.getSessionEntryAsync(target))?.label).toBe("Lisbon trip");
      }
    },
  );

  it.each(["reset", "manual rename"] as const)(
    "rejects a %s after label claim but before the Telegram edit",
    async (change) => {
      const base = createContext();
      const sessionKey = base.ctxPayload.SessionKey!;
      const storePath = base.turn.storePath;
      const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
      const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
        "openclaw/plugin-sdk/session-store-runtime",
      );
      const runtime = await import("openclaw/plugin-sdk/session-store-runtime");
      const target = { agentId: "default", storePath, sessionKey };
      const authority = { kind: "host" as const, assertCurrent() {} };
      await sdk.prepareSessionEntryPatch({
        ...target,
        fallbackEntry: { sessionId: "new", lifecycleRevision: "before", updatedAt: 1 },
        prepare: () => ({ label: "Email", topicName: "Email" }),
        authority,
        requireWriteSuccess: true,
      });
      mockDefaultSessionEntry({
        sessionId: "new",
        lifecycleRevision: "before",
        label: "Email",
        topicName: "Email",
        systemSent: true,
      });
      await updateTopicName(
        123,
        777,
        { name: "Email", labelState: { sessionId: "old", remainingMessages: 0 } },
        scope,
      );
      vi.spyOn(runtime, "prepareSessionEntryLabelClaim").mockImplementationOnce(async (params) => {
        const claimed = await sdk.prepareSessionEntryLabelClaim(params);
        expect(claimed).toBe(true);
        await sdk.prepareSessionEntryPatch({
          ...target,
          prepare: () =>
            change === "reset"
              ? { lifecycleRevision: "after" }
              : { label: "Manual", topicName: "Manual" },
          authority,
          requireWriteSuccess: true,
        });
        return claimed;
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      });
      const log = vi.spyOn(runtimeEnv, "logVerbose");
      generateTopicLabel.mockResolvedValueOnce("Lisbon trip");
      const bot = createBot();
      const edit = vi.spyOn(bot.api, "editForumTopic");
      await dispatchWithContext({
        context: createContext({
          accountId: "default",
          ctxPayload: {
            ...base.ctxPayload,
            RawBody: "Plan a trip",
            ThreadLabel: "Email",
            MessageSid: "12",
          },
        }),
        bot,
        streamMode: "off",
      });
      await waitForNaming(() =>
        expect(
          log.mock.calls.some(([message]) => message.includes("before Telegram edit")) ||
            edit.mock.calls.length > 0,
        ).toBe(true),
      );
      expect(edit).not.toHaveBeenCalled();
      const current = await sdk.getSessionEntryAsync(target);
      if (change === "reset") {
        expect(current?.lifecycleRevision).toBe("after");
      } else {
        expect(current?.label).toBe("Manual");
        expect(current?.topicName).toBe("Manual");
      }
    },
  );

  it("preserves unique labels when Telegram rename fails and the old label is claimed", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    const target = { agentId: "default", storePath, sessionKey };
    const authority = { kind: "host" as const, assertCurrent() {} };
    await sdk.prepareSessionEntryPatch({
      ...target,
      fallbackEntry: { sessionId: "new", updatedAt: 1 },
      prepare: () => ({ label: "Email", topicName: "Email" }),
      authority,
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({
      sessionId: "new",
      label: "Email",
      topicName: "Email",
      systemSent: true,
    });
    await updateTopicName(
      123,
      777,
      { name: "Email", labelState: { sessionId: "old", remainingMessages: 0 } },
      scope,
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const log = vi.spyOn(runtimeEnv, "logVerbose");
    generateTopicLabel.mockResolvedValueOnce("Lisbon trip");
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    edit.mockImplementationOnce(async () => {
      await sdk.prepareSessionEntryPatch({
        ...target,
        sessionKey: "agent:default:other",
        fallbackEntry: { sessionId: "other", updatedAt: 1 },
        prepare: () => ({ label: "Email" }),
        authority,
        requireWriteSuccess: true,
      });
      throw new Error("edit unavailable");
    });
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Plan a trip",
          ThreadLabel: "Email",
          MessageSid: "12",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("auto-topic-label: failed:")),
    );
    expect(edit).toHaveBeenCalledOnce();
    expect((await sdk.getSessionEntryAsync(target))?.label).toBe("Lisbon trip");
    expect(
      (await sdk.getSessionEntryAsync({ ...target, sessionKey: "agent:default:other" }))?.label,
    ).toBe("Email");
    expect((await getTopicLabelMetadata(123, 777, scope))?.name).toBe("Email");
  });

  it("preserves a manual label added after a non-claim title update", async () => {
    const base = createContext();
    const sessionKey = base.ctxPayload.SessionKey!;
    const storePath = base.turn.storePath;
    const scope = resolveTelegramDirectTopicNameCacheScope(storePath, "default");
    const sdk = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
      "openclaw/plugin-sdk/session-store-runtime",
    );
    const runtime = await import("openclaw/plugin-sdk/session-store-runtime");
    const target = { agentId: "default", storePath, sessionKey };
    const authority = { kind: "host" as const, assertCurrent() {} };
    await sdk.prepareSessionEntryPatch({
      ...target,
      fallbackEntry: { sessionId: "new", updatedAt: 1 },
      prepare: () => ({ topicName: "Email" }),
      authority,
      requireWriteSuccess: true,
    });
    mockDefaultSessionEntry({ sessionId: "new", topicName: "Email", systemSent: true });
    await updateTopicName(
      123,
      777,
      { name: "Email", labelState: { sessionId: "old", remainingMessages: 0 } },
      scope,
    );
    vi.spyOn(runtime, "prepareSessionEntryPatch").mockImplementationOnce(async (params) => {
      const result = await sdk.prepareSessionEntryPatch(params);
      await sdk.prepareSessionEntryPatch({
        ...target,
        prepare: () => ({ label: "Manual" }),
        authority,
        requireWriteSuccess: true,
      });
      return result;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const log = vi.spyOn(runtimeEnv, "logVerbose");
    generateTopicLabel.mockResolvedValueOnce("Lisbon trip");
    const bot = createBot();
    const edit = vi.spyOn(bot.api, "editForumTopic");
    await dispatchWithContext({
      context: createContext({
        accountId: "default",
        ctxPayload: {
          ...base.ctxPayload,
          RawBody: "Plan a trip",
          ThreadLabel: "Email",
          MessageSid: "12",
        },
      }),
      bot,
      streamMode: "off",
    });
    await waitForNaming(() =>
      expect(
        log.mock.calls.some(([message]) => message.includes("before Telegram edit")) ||
          edit.mock.calls.length > 0,
      ).toBe(true),
    );
    expect(edit).not.toHaveBeenCalled();
    expect((await sdk.getSessionEntryAsync(target))?.label).toBe("Manual");
  });
});
