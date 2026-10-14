import { describe, expect, it } from "vitest";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
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
});
