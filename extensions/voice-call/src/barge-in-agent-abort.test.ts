// Verifies barge-in cancels the run the interrupting call owns, and only that run.
import { describe, expect, it, vi } from "vitest";
import { BargeInAgentAbortCoordinator } from "./barge-in-agent-abort.js";

/** A tracked run plus the abort spy standing in for its cancellation authority. */
function trackedRun(runId: string, sessionId = "session-1") {
  const abort = vi.fn();
  return { abort, run: { sessionId, runId, abort } };
}

describe("BargeInAgentAbortCoordinator", () => {
  it("aborts the run registered for the barged-in call", () => {
    const coordinator = new BargeInAgentAbortCoordinator();
    const { abort, run } = trackedRun("run-1");
    coordinator.registerRun("call-1", run);

    expect(coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" })).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("attempts no abort for a turn with no run in flight", () => {
    const coordinator = new BargeInAgentAbortCoordinator();

    expect(coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" })).toBe(false);
  });

  it("aborts a given run at most once", () => {
    const coordinator = new BargeInAgentAbortCoordinator();
    const { abort, run } = trackedRun("run-1");
    coordinator.registerRun("call-1", run);

    coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" });
    // A second barge-in on the same turn must not re-abort an already-dead run.
    expect(coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" })).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("ignores a superseded run's clear so the replacement stays abortable", () => {
    const coordinator = new BargeInAgentAbortCoordinator();
    const first = trackedRun("run-1");
    const second = trackedRun("run-2");
    coordinator.registerRun("call-1", first.run);
    coordinator.registerRun("call-1", second.run);

    // The superseded turn settles late and clears with its own id.
    coordinator.clearRun("call-1", "run-1");

    expect(coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" })).toBe(true);
    expect(second.abort).toHaveBeenCalledTimes(1);
    expect(first.abort).not.toHaveBeenCalled();
  });

  it("aborts only the interrupted call's run when two calls share one session", () => {
    // maxConcurrentCalls > 1 with sessionScope "main" puts both calls in the
    // same session. Cancellation must follow call ownership, not the session.
    const coordinator = new BargeInAgentAbortCoordinator();
    const callA = trackedRun("run-a", "shared-session");
    const callB = trackedRun("run-b", "shared-session");
    coordinator.registerRun("call-a", callA.run);
    coordinator.registerRun("call-b", callB.run);

    coordinator.abortForBargeIn({ callId: "call-a", source: "streaming" });

    expect(callA.abort).toHaveBeenCalledTimes(1);
    expect(callB.abort).not.toHaveBeenCalled();
    // B's authority survives its sibling's interruption.
    expect(coordinator.abortForBargeIn({ callId: "call-b", source: "streaming" })).toBe(true);
    expect(callB.abort).toHaveBeenCalledTimes(1);
  });

  it("retires authority on settle so a later barge-in cannot abort finished work", () => {
    const coordinator = new BargeInAgentAbortCoordinator();
    const { abort, run } = trackedRun("run-1");
    coordinator.registerRun("call-1", run);

    coordinator.clearRun("call-1", "run-1");

    expect(coordinator.abortForBargeIn({ callId: "call-1", source: "streaming" })).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });
});
