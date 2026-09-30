import { describe, expect, it } from "vitest";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import { resolveCliNoOutputTimeoutDecision } from "./no-output-timeout-policy.js";

const CONTEXT = {
  provider: "claude-cli",
  model: "claude-sonnet-4-6",
  sessionId: "s1",
  lane: undefined,
};
// The grace the caller passes for outstanding work, which a blocked tool call already
// held on this path before compaction was a deferral term. Compaction inherits it
// rather than introducing a second, narrower allowance of its own.
const OUTSTANDING_WORK_GRACE_MS = BLOCKED_TOOL_CALL_ABORT_FLOOR_MS;

describe("resolveCliNoOutputTimeoutDecision", () => {
  it("defers past the no-output budget while native compaction is active", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 100,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 0,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        compactionActive: true,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    expect(decision.deferMs).toBe(OUTSTANDING_WORK_GRACE_MS - 100);
  });

  it("terminates once compaction has ended even with no other outstanding work", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 100,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 100,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        compactionActive: false,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    expect(decision.deferMs).toBeUndefined();
    expect(decision.error.message).toBe("CLI produced no output for 100s and was terminated.");
  });

  it("terminates when no compaction lifecycle event was ever observed", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 100,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 100,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        // A non-Claude backend never reports parseJsonlLifecycleEvent results,
        // so `compactionActive` is never set here, exactly like before this field existed.
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    expect(decision.deferMs).toBeUndefined();
    expect(decision.error.message).toBe("CLI produced no output for 100s and was terminated.");
  });

  it("still counts active tool or background work when compaction is not active", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 100,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 0,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 0,
        compactionActive: false,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    expect(decision.deferMs).toBe(OUTSTANDING_WORK_GRACE_MS - 100);
  });

  it("gives compaction the same grace a blocked tool call gets, with no separate allowance", () => {
    const shared = {
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 100,
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    };
    const compactionOnly = resolveCliNoOutputTimeoutDecision({
      ...shared,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 0,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        compactionActive: true,
      },
    });
    const toolOnly = resolveCliNoOutputTimeoutDecision({
      ...shared,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 0,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 0,
        compactionActive: false,
      },
    });

    // The point of the change: compaction is classified as outstanding work and takes
    // the identical branch, so there is no compaction-specific value to tune. A
    // reintroduced cap would make these two diverge here.
    expect(compactionOnly.deferMs).toBe(toolOnly.deferMs);
    expect(compactionOnly.deferMs).toBe(OUTSTANDING_WORK_GRACE_MS - 100);
  });

  it("terminates a compaction that never ends once the inherited floor is spent", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      // A start record with no end record and nothing after it: the quiet clock
      // restarted on that record, so the silence since the last record is the
      // silence since compaction start.
      quietDurationMs: OUTSTANDING_WORK_GRACE_MS,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: OUTSTANDING_WORK_GRACE_MS / 1000,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        compactionActive: true,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    // A wedged compaction is still detected, at the same point a wedged tool call is.
    expect(decision.deferMs).toBeUndefined();
    expect(decision.error.message).toBe("CLI produced no output for 900s and was terminated.");
  });

  it("keeps the blocked-tool floor when a tool is outstanding alongside compaction", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: 100,
      quietDurationMs: 300_000,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 300,
        observedActivity: true,
        activeToolCount: 1,
        backgroundTaskCount: 0,
        compactionActive: true,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    // Concurrent tool work is governed by the floor it always had; compaction on the
    // same tick neither widens nor narrows it.
    expect(decision.deferMs).toBe(OUTSTANDING_WORK_GRACE_MS - 300_000);
  });

  it("never shortens a configured no-output budget longer than the outstanding-work floor", () => {
    const decision = resolveCliNoOutputTimeoutDecision({
      context: CONTEXT,
      timeoutMs: OUTSTANDING_WORK_GRACE_MS * 2,
      quietDurationMs: OUTSTANDING_WORK_GRACE_MS,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: OUTSTANDING_WORK_GRACE_MS / 1000,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
        compactionActive: true,
      },
      hasOutputText: false,
      useResume: false,
      hasReplayUnsafeActivity: true,
      outstandingWorkGraceMs: OUTSTANDING_WORK_GRACE_MS,
    });

    expect(decision.deferMs).toBe(OUTSTANDING_WORK_GRACE_MS * 2 - OUTSTANDING_WORK_GRACE_MS);
  });
});
