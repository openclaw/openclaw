import { describe, expect, it, vi } from "vitest";
import { createCliTurnInterruptRequest, createCliYieldTurnEnd } from "./execute-turn-interrupt.js";

const alreadyPending = {
  outcome: "completed",
  result: { content: [], details: { status: "already_pending", pendingChildren: [] } },
};

function setup() {
  const interrupt = vi.fn(async () => {});
  const turnInterrupt = createCliTurnInterruptRequest();
  turnInterrupt.register({ interrupt });
  return { interrupt, turnEnd: createCliYieldTurnEnd(turnInterrupt) };
}

describe("CLI yield turn end", () => {
  it("ends an input at an already-pending yield after that input delivered its reply", async () => {
    const { interrupt, turnEnd } = setup();
    turnEnd.markDelivered(true);
    turnEnd.observe("sessions_yield", alreadyPending);
    turnEnd.onToolResult("mcp__openclaw__sessions_yield", false);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("source_reply"));
    expect(turnEnd.suppressesAssistantOutput()).toBe(true);
  });

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

  it("still ends a real yield regardless of delivery", async () => {
    const { interrupt, turnEnd } = setup();
    turnEnd.markYielded();
    turnEnd.onToolResult("sessions_yield", false);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledWith("yield"));
  });
});
