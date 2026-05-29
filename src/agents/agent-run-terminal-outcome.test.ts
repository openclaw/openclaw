import { describe, expect, it } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  isHardAgentRunTimeoutPhase,
  mergeAgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";

describe("agent run terminal outcome", () => {
  it("treats provider/preflight/post-turn timeout phases as hard run timeouts", () => {
    expect(isHardAgentRunTimeoutPhase("preflight")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("provider")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("post_turn")).toBe(true);
    expect(isHardAgentRunTimeoutPhase("queue")).toBe(false);
    expect(isHardAgentRunTimeoutPhase("gateway_draining")).toBe(false);
  });

  it("keeps queue and gateway draining timeouts non-sticky", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
      }).reason,
    ).toBe("timed_out");
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        timeoutPhase: "queue",
      }).reason,
    ).toBe("timed_out");
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        timeoutPhase: "gateway_draining",
      }).reason,
    ).toBe("timed_out");
  });

  it("keeps explicit rpc and stop cancellations sticky even with queue attribution", () => {
    const rpcCancel = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
      endedAt: 100,
    });
    const lateCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 200,
    });

    expect(rpcCancel.reason).toBe("cancelled");
    expect(rpcCancel.status).toBe("timeout");
    expect(mergeAgentRunTerminalOutcome(rpcCancel, lateCompletion)).toBe(rpcCancel);
    expect(
      buildAgentRunTerminalOutcome({
        status: "timeout",
        stopReason: "stop",
        timeoutPhase: "gateway_draining",
      }).reason,
    ).toBe("cancelled");
  });

  it("does not treat successful model stop metadata as cancellation", () => {
    expect(
      buildAgentRunTerminalOutcome({
        status: "ok",
        stopReason: "stop",
      }),
    ).toEqual({
      reason: "completed",
      status: "ok",
      stopReason: "stop",
    });
  });

  it("keeps a hard timeout over later aborts or failures for the same run", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const lateAbort = buildAgentRunTerminalOutcome({
      status: "error",
      stopReason: "aborted",
      endedAt: 250,
    });
    const lateFailure = buildAgentRunTerminalOutcome({
      status: "error",
      error: "late rejection",
      endedAt: 260,
    });

    expect(mergeAgentRunTerminalOutcome(timeout, lateAbort)).toBe(timeout);
    expect(mergeAgentRunTerminalOutcome(timeout, lateFailure)).toBe(timeout);
  });

  it("lets an earlier proven completion correct a provisional timeout", () => {
    const timeout = buildAgentRunTerminalOutcome({
      status: "timeout",
      timeoutPhase: "provider",
      endedAt: 200,
    });
    const earlierCompletion = buildAgentRunTerminalOutcome({
      status: "ok",
      endedAt: 190,
    });

    expect(mergeAgentRunTerminalOutcome(timeout, earlierCompletion)).toBe(earlierCompletion);
  });
});
