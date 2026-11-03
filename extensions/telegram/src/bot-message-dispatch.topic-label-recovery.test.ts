import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchWithContext,
  dispatchReplyWithBufferedBlockDispatcher,
  generateTopicLabel,
  mockDefaultSessionEntry,
} from "./bot-message-dispatch.test-harness.js";
import {
  getTopicName,
  resolveTelegramDirectTopicNameCacheScope,
  updateTopicName,
} from "./topic-name-cache.js";

describeTelegramDispatch("DM topic label recovery", () => {
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
