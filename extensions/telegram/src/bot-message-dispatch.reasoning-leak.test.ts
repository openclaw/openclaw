import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { describe, expect, it } from "vitest";
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
        gpufarm: {
          models: [{ id: "leaky", compat: { emitsReasoningInContent: true } }],
        },
      },
    },
  };

  function produce(producer: Producer, scenario: Partial<Scenario> = {}) {
    return dispatchProgressTurn(async () => undefined, {
      mode: "partial",
      toolProgress: false,
      ...scenario,
      producer,
    });
  }

  const messageCalls = () => [
    ...http.callsFor("sendMessage"),
    ...http.callsFor("editMessageText"),
  ];

  it("leaves no visible artifact when a flagged model's reasoning streams into a silent turn", async () => {
    const leaked = "Leaked chain-of-thought that must never reach Telegram. ";
    await produce(
      async ({ dispatcher, replyOptions }) => {
        // Failover selects the flagged provider/model mid-turn.
        await replyOptions?.onModelSelected?.({
          provider: "gpufarm",
          model: "leaky",
          thinkLevel: undefined,
        });
        // The flagged endpoint streams reasoning into the content lane.
        await replyOptions?.onPartialReply?.({ text: leaked });
        // The model produced no user-facing reply; the final settles silently.
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata({ text: "NO_REPLY" }, { silentReply: true }),
        );
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
      { cfg: flaggedCfg },
    );
    // Nothing leaked and nothing was delivered: zero visible artifacts.
    expect(http.texts()).toEqual([]);
    expect(
      messageCalls().some((call) => String(call.fields.text).includes("Leaked chain-of-thought")),
    ).toBe(false);
  });

  it("keeps normal preview streaming for a well-behaved model", async () => {
    const streamed = "Normal streamed answer that should preview and paginate. ";
    const final = "The complete normal answer.";
    await produce(
      async ({ dispatcher, replyOptions }) => {
        await replyOptions?.onModelSelected?.({
          provider: "gpufarm",
          model: "well-behaved",
          thinkLevel: undefined,
        });
        await replyOptions?.onPartialReply?.({ text: streamed });
        // Wait for the preview to land so the streamed text is recorded deterministically.
        await http.waitForContaining(streamed, "sendMessage");
        dispatcher.sendFinalReply({ text: final });
        const counts = dispatcher.getQueuedCounts();
        return { queuedFinal: counts.final > 0, counts };
      },
      {
        cfg: {
          models: { providers: { gpufarm: { models: [{ id: "well-behaved" }] } } },
        },
      },
    );
    // Well-behaved models keep previewing the streamed answer (streaming unchanged).
    expect(
      messageCalls().some((call) => String(call.fields.text).includes("Normal streamed answer")),
    ).toBe(true);
    expect(http.texts()).toContain(final);
  });
});
