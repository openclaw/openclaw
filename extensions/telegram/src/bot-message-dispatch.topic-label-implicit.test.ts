import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
} from "./bot-message-dispatch.test-harness.js";
import { resolveTelegramForumTopicMetadata } from "./forum-topic-metadata.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";
import { resolveTelegramDirectTopicNameCacheScope } from "./topic-name-cache.js";

describeTelegramDispatch("implicit Telegram topic names", () => {
  it.each([
    { implicit: true, edited: false },
    { implicit: false, edited: false },
    { implicit: true, edited: true },
  ])("names only an unedited implicit creation: %j", async ({ implicit, edited }) => {
    const context = createContext();
    context.ctxPayload.RawBody = "Plan the kitchen lighting";
    const scope = resolveTelegramDirectTopicNameCacheScope(context.turn.storePath, "default");
    await resolveTelegramForumTopicMetadata({
      msg: {
        ...context.msg,
        forum_topic_created: {
          name: "New Chat",
          icon_color: 9367192,
          ...(implicit ? { is_name_implicit: true as const } : {}),
        },
      },
      threadId: 777,
      scope,
    });
    if (edited) {
      await resolveTelegramForumTopicMetadata({
        msg: { ...context.msg, forum_topic_edited: { name: "New Chat" } },
        threadId: 777,
        scope,
      });
    }
    // Admission must consume durable provenance, not the original service object.
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Task reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const bot = createBot();
    const edit = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = edit;
    const work = new AsyncWorkScope();
    await work.track(() => dispatchWithContext({ context, bot }));
    await work.drain();
    if (implicit && !edited) {
      expect(edit).toHaveBeenCalledWith(123, 777, { name: "Topic label" });
      expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    } else {
      expect(generateTopicLabel).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
    }
  });
});
