import { describe, expect, it } from "vitest";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
  observeSettlement,
} from "./translator.prompt-harness.test-support.js";

describe("acp translator errorKind mapping", () => {
  it.each([
    ["refusal", "refusal"],
    ["unknown", "end_turn"],
  ])("maps %s errors to %s", async (errorKind, stopReason) => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();
    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind,
        errorMessage: "gateway error",
      }),
    );
    await expect(promptPromise).resolves.toEqual({ stopReason });
  });

  it.each([["refusal"], ["unknown"]])(
    "delivers the %s error text to the client before settlement",
    async (errorKind) => {
      const { agent, promptPromise, runId, sessionUpdate } = await createPendingPromptHarness();
      const settlement = observeSettlement(promptPromise);
      const errorMessage =
        "The model reached its output token limit before generating an answer. Please try again.";
      await agent.handleGatewayEvent(
        createChatEvent({
          runId,
          sessionKey: DEFAULT_SESSION_KEY,
          seq: 1,
          state: "error",
          errorKind,
          errorMessage,
        }),
      );
      await expect(promptPromise).resolves.toEqual({
        stopReason: errorKind === "refusal" ? "refusal" : "end_turn",
      });
      expect(sessionUpdate).toHaveBeenCalledWith({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[OpenClaw interruption] ${errorMessage}` },
        },
      });
      expect(sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        settlement.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    },
  );

  it("settles without a notice chunk when the error event carries no message", async () => {
    const { agent, promptPromise, runId, sessionUpdate } = await createPendingPromptHarness();
    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
      }),
    );
    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      sessionUpdate.mock.calls.filter(
        ([, update]) => update?.sessionUpdate === "agent_message_chunk",
      ),
    ).toEqual([]);
  });
});
