import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
  loadSessionStore,
} from "./bot-message-dispatch.test-harness.js";
import { getTelegramRuntime } from "./runtime.js";

describeTelegramDispatch("initial topic-label recovery", () => {
  it("resumes refinement after the initial edit lands but its final state write fails", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Task reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const state = getTelegramRuntime().state;
    const openStore = state.openKeyedStore;
    let interrupted = false;
    state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => {
      const store = openStore<T>(options);
      return {
        ...store,
        register: async (...args: Parameters<PluginStateKeyedStore<T>["register"]>) => {
          const [, value] = args;
          if (
            !interrupted &&
            options.namespace === "telegram.topic-label-refinement" &&
            expect.objectContaining({ label: "Topic label" }).asymmetricMatch(value)
          ) {
            interrupted = true;
            throw new Error("interrupted after Telegram edit and cache commit");
          }
          return store.register(...args);
        },
      };
    };
    const context = createContext();
    context.ctxPayload.RawBody = "Plan the release";
    const bot = createBot();
    const editForumTopic = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = editForumTopic;
    const telegramCfg = { autoTopicLabel: { refine: true, refineAfterMessages: 1 } };
    try {
      await dispatchWithContext({ context, bot, telegramCfg });
      await vi.waitFor(() => expect(interrupted).toBe(true), { timeout: 5000 });
    } finally {
      state.openKeyedStore = openStore;
    }
    // Reopen the real persisted store; no synthetic refinement state is seeded.
    resetPluginStateStoreForTests();
    loadSessionStore.mockReturnValue({ [context.ctxPayload.SessionKey!]: { systemSent: true } });
    context.ctxPayload.RawBody = "Include the rollout checklist";
    generateTopicLabel.mockResolvedValue("Release checklist");
    await dispatchWithContext({ context, bot, telegramCfg });
    await vi.waitFor(() =>
      expect(editForumTopic).toHaveBeenLastCalledWith(123, 777, {
        name: "Release checklist",
      }),
    );
    expect(generateTopicLabel).toHaveBeenCalledTimes(2);
  });
});
