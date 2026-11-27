import { assert, describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";

describe("Telegram preparation feedback through the real reply pipeline and HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const telegramCfg = {
    streaming: { mode: "progress" as const, progress: { commentary: true, toolProgress: true } },
  };

  it.each([true, false])(
    "shows preparation with tool telemetry enabled=%s",
    async (toolProgress) => {
      let progressId: number | undefined;
      await http.dispatchProgressTurn(
        async (options) => {
          expect([...http.visibleMessages.values()].join(" ")).toContain("Message received");
          expect(http.visibleMessages.size).toBe(1);
          progressId = [...http.visibleMessages.keys()][0];
          await options?.onReplyPreparation?.("context");
          expect([...http.visibleMessages.values()].join(" ")).toContain("Preparing my reply");
        },
        {
          mode: "progress",
          toolProgress,
          telegramCfg: {
            streaming: { mode: "progress", progress: { commentary: true, toolProgress } },
          },
          finalReply: { text: "Finished." },
        },
      );
      assert(progressId !== undefined);
      const writes = http.acceptedCalls.filter((call) =>
        ["sendMessage", "editMessageText", "deleteMessage"].includes(call.method),
      );
      // Progress mode keeps its temporary card until a separate final is accepted.
      expect(writes.map((call) => call.method)).toEqual([
        "sendMessage",
        "editMessageText",
        "sendMessage",
        "deleteMessage",
      ]);
      expect(writes[0]?.fields.text).toContain("Message received");
      expect(writes[1]?.fields.text).toContain("Preparing my reply");
      expect(Number(writes[1]?.fields.message_id)).toBe(progressId);
      expect(writes[2]?.fields.text).toBe("Finished.");
      expect(Number(writes[3]?.fields.message_id)).toBe(progressId);
      expect(http.visibleMessages.has(progressId)).toBe(false);
      expect([...http.visibleMessages.values()]).toEqual(["Finished."]);
    },
  );

  it.each(["accepted", "rejected", "unsupported"] as const)(
    "keeps receipt visibility tied to the native reaction result: %s",
    async (outcome) => {
      http.respondToCall = (call) =>
        outcome === "rejected" && call.method === "setMessageReaction"
          ? { error_code: 400, description: "REACTION_INVALID" }
          : undefined;
      const context = http.createContext();
      const producer = await buildTelegramMessageContextForTest({
        message: {
          ...context.msg,
          chat: {
            ...context.msg.chat,
            available_reactions: outcome === "unsupported" ? [] : null,
          },
        },
        cfg: {
          channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
          messages: { ackReaction: "👀", statusReactions: { enabled: true } },
        },
        ackReactionScope: "direct",
        botApi: {
          getChat: http.bot.api.getChat.bind(http.bot.api),
          setMessageReaction: http.bot.api.setMessageReaction.bind(http.bot.api),
        },
      });
      assert(producer);
      assert(producer.statusReactionController);
      assert(producer.ackReactionPromise);
      context.ackReactionPromise = producer.ackReactionPromise;
      try {
        await http.dispatchProgressTurn(
          async (options) => {
            expect(http.visibleMessages.size).toBe(outcome === "accepted" ? 0 : 1);
            expect(http.calls.filter((call) => call.method === "setMessageReaction")).toHaveLength(
              outcome === "unsupported" ? 0 : 1,
            );
            await options?.onReplyPreparation?.("context");
            expect([...http.visibleMessages.values()].join(" ")).toContain("Preparing my reply");
          },
          {
            mode: "progress",
            toolProgress: true,
            telegramCfg,
            context,
            finalReply: { text: "Finished." },
          },
        );
        expect([...http.visibleMessages.values()]).toEqual(["Finished."]);
      } finally {
        await producer.statusReactionController.restoreInitial();
      }
    },
  );

  it("keeps commentary opt-outs silent before the final answer", async () => {
    await http.dispatchProgressTurn(
      async (options) => {
        await options?.onReplyPreparation?.("context");
        expect(http.visibleMessages.size).toBe(0);
      },
      { mode: "progress", toolProgress: true, finalReply: { text: "Finished." } },
    );
  });
});
