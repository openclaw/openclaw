import { describe, expect, it, vi } from "vitest";
import { createCliTurnInterruptRequest, createCliYieldTurnEnd } from "./execute-turn-interrupt.js";

function pendingCall(state: "running" | "paused", wakeArmed: boolean) {
  return {
    outcome: "completed",
    result: {
      content: [],
      details: {
        status: "already_pending",
        pendingChildren: [
          {
            runId: "earlier-child",
            childSessionKey: "agent:main:subagent:child",
            state,
            wakeArmed,
          },
        ],
      },
    },
  };
}
const alreadyPending = pendingCall("running", true);

function setup() {
  const interrupt = vi.fn(async () => {});
  const turnInterrupt = createCliTurnInterruptRequest();
  turnInterrupt.register({ interrupt });
  return { interrupt, turnEnd: createCliYieldTurnEnd(turnInterrupt) };
}

describe("CLI yield turn end", () => {
  it("keeps a steered input's turn open when only the earlier input delivered", async () => {
    const { interrupt, turnEnd } = setup();
    turnEnd.markDelivered(true);
    turnEnd.beginInput();
    turnEnd.observe("sessions_yield", alreadyPending);
    turnEnd.onToolResult("mcp__openclaw__sessions_yield", false);
    await Promise.resolve();
    expect(interrupt).not.toHaveBeenCalled();
    expect(turnEnd.suppressesAssistantOutput()).toBe(false);
  });

  it.each([
    ["paused", true],
    ["running", false],
  ] as const)(
    "keeps the turn open when no pending child will wake the session (%s, armed %s)",
    async (state, wakeArmed) => {
      const { interrupt, turnEnd } = setup();
      turnEnd.markDelivered(true);
      turnEnd.observe("sessions_yield", pendingCall(state, wakeArmed));
      turnEnd.onToolResult("mcp__openclaw__sessions_yield", false);
      await Promise.resolve();
      expect(interrupt).not.toHaveBeenCalled();
      expect(turnEnd.suppressesAssistantOutput()).toBe(false);
    },
  );

  it("still ends a real yield regardless of delivery", async () => {
    const { interrupt, turnEnd } = setup();
    turnEnd.markYielded();
    turnEnd.onToolResult("sessions_yield", false);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("yield"));
  });
});
