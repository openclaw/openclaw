import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";

// Incident regression: a provider/model that emits its own reasoning into the
// OpenAI-compatible content stream (compat.emitsReasoningInContent) must not leak
// that reasoning into the visible Telegram lane, and a silent final must leave no
// orphaned artifacts behind.
describe("Telegram reasoning-in-content leak cleanup", () => {
  const http = createTelegramDispatchHttpFixture();
  const { dispatchProgressTurn } = http;
  type Scenario = NonNullable<Parameters<typeof dispatchProgressTurn>[1]>;
  type Producer = NonNullable<Scenario["producer"]>;

  const flaggedCfg = {
    models: {
      providers: {
        "local-endpoint": {
          models: [
            { id: "leaky", compat: { emitsReasoningInContent: true } },
            { id: "well-behaved" },
          ],
        },
      },
    },
  };

  function produce(producer: Producer, scenario: Partial<Scenario> = {}) {
    return dispatchProgressTurn(async () => undefined, {
      mode: "partial",
      toolProgress: false,
      cfg: flaggedCfg,
      ...scenario,
      producer,
    });
  }

  const selectModel = (
    replyOptions: Parameters<Producer>[0]["replyOptions"],
    model: "leaky" | "well-behaved",
  ) =>
    replyOptions?.onModelSelected?.({ provider: "local-endpoint", model, thinkLevel: undefined });

  const silentFinal = () => setReplyPayloadMetadata({ text: "NO_REPLY" }, { silentReply: true });

  const messageCalls = () => [...http.callsFor("sendMessage"), ...http.callsFor("editMessageText")];
  const sentAnyContaining = (text: string) =>
    messageCalls().some((call) => String(call.fields.text).includes(text));

  it("leaves no visible artifact when a flagged model's reasoning streams into a silent turn", async () => {
    const leaked = "Leaked chain-of-thought that must never reach Telegram. ";
    await produce(async ({ dispatcher, replyOptions }) => {
      // Failover selects the flagged provider/model mid-turn.
      await selectModel(replyOptions, "leaky");
      // The flagged endpoint streams reasoning into the content lane.
      await replyOptions?.onPartialReply?.({ text: leaked });
      // The model produced no user-facing reply; the final settles silently.
      dispatcher.sendFinalReply(silentFinal());
      const counts = dispatcher.getQueuedCounts();
      return { queuedFinal: counts.final > 0, counts };
    });
    // Nothing leaked and nothing was delivered: zero visible artifacts.
    expect(http.texts()).toEqual([]);
    expect(sentAnyContaining("Leaked chain-of-thought")).toBe(false);
  });

  it.each([
    { model: "leaky", answer: undefined, visible: [] },
    { model: "leaky", answer: "The actual reply.", visible: ["The actual reply."] },
    {
      model: "well-behaved",
      answer: "The actual reply.",
      visible: ["Let me reason through this privately first.", "The actual reply."],
    },
  ] as const)(
    "gates block-streamed text on the model flag ($model, answer: $answer)",
    async ({ model, answer, visible }) => {
      const untagged = "Let me reason through this privately first.";
      await produce(
        async ({ dispatcher, replyOptions }) => {
          await selectModel(replyOptions, model);
          // Untagged reasoning arrives as an ordinary block; no tag marks it.
          dispatcher.sendBlockReply({ text: untagged });
          await dispatcher.waitForIdle();
          dispatcher.sendFinalReply(answer ? { text: answer } : silentFinal());
          const counts = dispatcher.getQueuedCounts();
          return { queuedFinal: counts.final > 0, counts };
        },
        // Explicit block streaming leaves the turn without an answer preview stream.
        { telegramCfg: { streaming: { mode: "partial", block: { enabled: true } } } },
      );
      expect(http.texts()).toEqual(visible);
      expect(sentAnyContaining(untagged)).toBe(model === "well-behaved");
    },
  );

  it("settles a flagged final that strips to nothing as silent and clears its preview", async () => {
    const streamed = "Primary model preview that pages past the limit. ".repeat(3);
    const context = http.createContext();
    const statusReactions = {
      setQueued: vi.fn(),
      setThinking: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setCompacting: vi.fn(async () => {}),
      cancelPending: vi.fn(),
      setError: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    };
    context.statusReactionController = statusReactions;
    let previewId: number | undefined;
    await produce(
      async ({ dispatcher, replyOptions }) => {
        await selectModel(replyOptions, "well-behaved");
        await replyOptions?.onPartialReply?.({ text: streamed });
        await http.waitForContaining("Primary model preview", "sendMessage");
        previewId = [...http.visibleMessages.keys()][0];
        // Failover hands the turn to the flagged model, whose final is reasoning only.
        await selectModel(replyOptions, "leaky");
        dispatcher.sendFinalReply({ text: "<think>private reasoning</think>" });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
      { textLimit: 80, context },
    );
    expect.soft(http.texts()).toEqual([]);
    expect.soft(sentAnyContaining("private reasoning")).toBe(false);
    expect
      .soft(http.acceptedFor("deleteMessage").map((call) => Number(call.fields.message_id)))
      .toEqual([previewId]);
    // An intentional silent turn finishes as done, not through the error reaction.
    expect.soft(statusReactions.setError).not.toHaveBeenCalled();
    expect.soft(statusReactions.setDone).toHaveBeenCalledTimes(1);
  });

  it("keeps normal preview streaming for a well-behaved model", async () => {
    const streamed = "Normal streamed answer that should preview.";
    const final = "The complete normal answer.";
    await produce(async ({ dispatcher, replyOptions }) => {
      await selectModel(replyOptions, "well-behaved");
      await replyOptions?.onPartialReply?.({ text: streamed });
      // Wait for the preview to land so the streamed text is recorded deterministically.
      await http.waitForContaining(streamed, "sendMessage");
      dispatcher.sendFinalReply({ text: final });
      const counts = dispatcher.getQueuedCounts();
      return { queuedFinal: counts.final > 0, counts };
    });
    // Well-behaved models keep previewing the streamed answer (streaming unchanged).
    expect(sentAnyContaining("Normal streamed answer")).toBe(true);
    expect(http.texts()).toContain(final);
  });
});
