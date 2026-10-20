import { describe, expect, it } from "vitest";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

const sessionId = "session-1";
const sessionKey = "agent:main:main";

describe("acp translator errorKind mapping", () => {
  it.each([
    ["refusal", "refusal"],
    ["unknown", "end_turn"],
  ])("records and delivers %s errors before settling as %s", async (errorKind, stopReason) => {
    const eventLedger = createTestAcpEventLedger();
    await eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
    const h = createPromptScenario({ eventLedger });
    const prompt = h.start();
    const runId = await prompt.sent;
    const error = { state: "error", errorKind, errorMessage: "gateway error" };
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "[OpenClaw interruption] gateway error" },
    };
    await h.chat(runId, error);
    await expect(prompt.result).resolves.toEqual({ stopReason });
    await h.chat(runId, error);
    expect(
      h.sessionUpdate.mock.calls.flatMap(([notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk" ? [notification.update] : [],
      ),
    ).toEqual([update]);
    expect(h.sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.settlement.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const replay = await eventLedger.readReplay({ sessionId, sessionKey });
    expect(replay.events.map((event) => event.update)).toContainEqual(update);
  });

  it("settles errors without a message without emitting an empty notice", async () => {
    const h = createPromptScenario();
    const prompt = h.start();
    await h.chat(await prompt.sent, { state: "error" });
    await expect(prompt.result).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      h.sessionUpdate.mock.calls.some(
        ([notification]) => notification.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(false);
  });
});
