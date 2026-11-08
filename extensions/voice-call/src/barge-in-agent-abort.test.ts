// Voice Call tests cover the opt-in barge-in agent-run abort coordinator.
import { describe, expect, it, vi } from "vitest";
import { BargeInAgentAbortCoordinator } from "./barge-in-agent-abort.js";

function createCoordinator(
  options: {
    abortAgentRun?: (sessionId: string) => boolean;
  } = {},
) {
  const abortAgentRun = vi.fn(options.abortAgentRun ?? (() => true));
  const log = vi.fn<(message: string) => void>();
  const coordinator = new BargeInAgentAbortCoordinator({ abortAgentRun, log });
  /** Barge-in abort, which is also the only observable read of tracked state. */
  const bargeIn = (callId: string) => coordinator.abortForBargeIn({ callId, source: "local" });
  return { coordinator, abortAgentRun, log, bargeIn };
}

function registerRun(
  coordinator: BargeInAgentAbortCoordinator,
  overrides: { callId?: string; runId?: string } = {},
) {
  const callId = overrides.callId ?? "call-1";
  coordinator.registerRun(callId, {
    sessionId: "session-1",
    runId: overrides.runId ?? "run-1",
  });
  return callId;
}

describe("BargeInAgentAbortCoordinator", () => {
  it("stays silent and attempts nothing for a turn that never delegated to the agent", () => {
    const { abortAgentRun, log, bargeIn } = createCoordinator();

    expect(bargeIn("call-without-consult")).toBe(false);
    expect(abortAgentRun).not.toHaveBeenCalled();
    // Deliberately silent: the streaming trigger fires on every partial
    // transcript, so logging each miss would flood the log per utterance.
    expect(log).not.toHaveBeenCalled();
  });

  it("aborts the tracked run by session id and logs its identity", () => {
    const { coordinator, abortAgentRun, log, bargeIn } = createCoordinator();
    const callId = registerRun(coordinator);

    expect(bargeIn(callId)).toBe(true);

    expect(abortAgentRun).toHaveBeenCalledWith("session-1");
    // Run identity lives in the log now that the caller only needs the
    // boolean, so the log is what has to carry it.
    const line = log.mock.calls[0]?.[0] ?? "";
    expect(line).toContain("barge-in aborted agent run");
    expect(line).toContain("runId=run-1");
    expect(line).toContain("sessionId=session-1");
  });

  it("does not re-abort after the first barge-in of a turn", () => {
    const { coordinator, abortAgentRun, bargeIn } = createCoordinator();
    const callId = registerRun(coordinator);

    expect(bargeIn(callId)).toBe(true);
    expect(bargeIn(callId)).toBe(false);
    expect(abortAgentRun).toHaveBeenCalledTimes(1);
  });

  it("reports failure silently when the run was already gone", () => {
    const { coordinator, log, bargeIn } = createCoordinator({ abortAgentRun: () => false });
    const callId = registerRun(coordinator);

    expect(bargeIn(callId)).toBe(false);
    // Silent on purpose: the turn settling just before the abort lands is
    // routine timing, and it fired several times per call as a pseudo-error.
    expect(log).not.toHaveBeenCalled();
  });

  it("lets an abort throw reach the caller, which owns the audio-path guard", () => {
    const { coordinator, bargeIn } = createCoordinator({
      abortAgentRun: () => {
        throw new Error("run registry exploded");
      },
    });
    const callId = registerRun(coordinator);

    // The coordinator no longer double-guards: every caller already wraps this
    // in try/catch so the inbound audio path cannot be broken by an abort.
    expect(() => bargeIn(callId)).toThrow("run registry exploded");
    // The run is cleared before the abort, so a retry cannot re-abort it.
    expect(bargeIn(callId)).toBe(false);
  });

  it("only forgets the run a settle names, per call", () => {
    const { coordinator, bargeIn } = createCoordinator();
    registerRun(coordinator, { callId: "call-stale", runId: "run-2" });
    registerRun(coordinator, { callId: "call-settled", runId: "run-2" });

    // A late cleanup from a superseded run must not drop the run that
    // replaced it, and each call keeps its own tracked run.
    coordinator.clearRun("call-stale", "run-1");
    coordinator.clearRun("call-settled", "run-2");

    expect(bargeIn("call-stale")).toBe(true);
    expect(bargeIn("call-settled")).toBe(false);
  });

  it("drops the tracked run when the call ends", () => {
    const { coordinator, bargeIn } = createCoordinator();
    const callId = registerRun(coordinator);

    // Teardown omits the runId to drop whatever is tracked.
    coordinator.clearRun(callId);

    expect(bargeIn(callId)).toBe(false);
  });
});
