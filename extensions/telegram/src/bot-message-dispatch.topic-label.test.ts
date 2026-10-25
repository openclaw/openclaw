import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";
import { resolveTelegramDirectTopicNameCacheScope, updateTopicName } from "./topic-name-cache.js";

describeTelegramDispatch("Telegram generated topic refinement", () => {
  const sessionKey = "agent:default:telegram:direct:123";
  const context = (text: string) => {
    const result = createContext();
    result.ctxPayload = {
      ...result.ctxPayload,
      SessionKey: sessionKey,
      RawBody: text,
      CommandAuthorized: true,
    };
    return result;
  };
  const reply = () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
  };

  it("renames through dispatch after six task follow-ups, once, including registered skills", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    mockDefaultSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: context("Plan the release"), bot });
    expect(editForumTopic).toHaveBeenLastCalledWith(123, 777, { name: "Topic label" });
    mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
    generateTopicLabel.mockResolvedValue("Fix release signing");
    await dispatchWithContext({
      context: { ...context("/review disabled task"), skillFilter: ["another-skill"] },
      bot,
    });
    for (const text of ["/status", "/unknown task", ...Array<string>(5).fill("/review signing")]) {
      await dispatchWithContext({ context: context(text), bot });
    }
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await dispatchWithContext({ context: context("Fix the certificate"), bot });
    expect(editForumTopic).toHaveBeenLastCalledWith(123, 777, {
      name: "Fix release signing",
    });
    for (let index = 0; index < 7; index++) {
      await dispatchWithContext({ context: context("More detail"), bot });
    }
    expect(editForumTopic).toHaveBeenCalledTimes(2);
  });

  it("preserves a manual rename during inference", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    const initial = context("Plan the release");
    const scope = resolveTelegramDirectTopicNameCacheScope(initial.turn.storePath, "default");
    mockDefaultSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: initial, bot });
    mockDefaultSessionEntry({ sessionId: "s1", systemSent: true });
    for (let index = 0; index < 5; index++) {
      await dispatchWithContext({ context: context("Signing problem"), bot });
    }
    generateTopicLabel.mockImplementationOnce(async () => {
      await updateTopicName(123, 777, { name: "My release" }, scope);
      return "Fix release signing";
    });
    await dispatchWithContext({ context: context("Fix it"), bot });
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("does not refine generated names belonging to a previous session", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    mockDefaultSessionEntry({ sessionId: "s1" });
    await dispatchWithContext({ context: context("Plan the release"), bot });
    mockDefaultSessionEntry({ sessionId: "s2", systemSent: true });
    for (let index = 0; index < 7; index++) {
      await dispatchWithContext({ context: context("New conversation"), bot });
    }
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("preserves a manual name in the metadata owner's scope when the session uses another store", async () => {
    reply();
    const bot = createBot();
    const editForumTopic = vi.spyOn(bot.api, "editForumTopic");
    mockDefaultSessionEntry({ sessionId: "s1" });
    const initial = context("Plan the release");
    initial.topicNameCacheScope = "separate-account-owner-store";
    await updateTopicName(123, 777, { name: "My project" }, initial.topicNameCacheScope);
    await dispatchWithContext({ context: initial, bot });
    expect(editForumTopic).not.toHaveBeenCalled();
  });
});
