// Coverage for live deterministic tool-failure loop detection.
import { describe, expect, it } from "vitest";
import {
  createLiveToolFailureLoopGuard,
  LiveToolFailureLoopError,
} from "./live-tool-failure-loop-guard.js";

function callOutcome(params?: {
  toolName?: string;
  argsHash?: string;
  resultHash?: string;
  isError?: boolean;
}) {
  return {
    toolName: params?.toolName ?? "message",
    argsHash: params?.argsHash ?? "args",
    resultHash: params?.resultHash ?? "error",
    isError: params?.isError,
  };
}

describe("createLiveToolFailureLoopGuard", () => {
  it("uses the documented critical threshold by default", () => {
    const guard = createLiveToolFailureLoopGuard();

    for (let i = 0; i < 19; i += 1) {
      expect(guard.observe(callOutcome({ isError: true })).shouldAbort).toBe(false);
    }

    const twentieth = guard.observe(callOutcome({ isError: true }));
    expect(twentieth.shouldAbort).toBe(true);
    if (twentieth.shouldAbort) {
      expect(twentieth.detector).toBe("live_tool_failure_loop");
      expect(twentieth.count).toBe(20);
      expect(twentieth.toolName).toBe("message");
    }
  });

  it("uses criticalThreshold when configured", () => {
    const guard = createLiveToolFailureLoopGuard({ criticalThreshold: 2 });

    expect(guard.observe(callOutcome({ isError: true })).shouldAbort).toBe(false);
    expect(guard.observe(callOutcome({ isError: true })).shouldAbort).toBe(true);
  });

  it("does not count successful repeated outcomes", () => {
    const guard = createLiveToolFailureLoopGuard();

    for (let i = 0; i < 10; i += 1) {
      expect(guard.observe(callOutcome()).shouldAbort).toBe(false);
    }
  });

  it("resets the streak after progress", () => {
    const guard = createLiveToolFailureLoopGuard({ criticalThreshold: 2 });

    expect(guard.observe(callOutcome({ isError: true }))).toEqual({
      shouldAbort: false,
      count: 1,
    });
    expect(guard.observe(callOutcome({ isError: false }))).toEqual({
      shouldAbort: false,
      count: 0,
    });
    expect(guard.observe(callOutcome({ isError: true }))).toEqual({
      shouldAbort: false,
      count: 1,
    });
  });

  it("does not combine different args or results", () => {
    const guard = createLiveToolFailureLoopGuard({ criticalThreshold: 2 });

    expect(
      guard.observe(callOutcome({ argsHash: "a", resultHash: "same", isError: true })),
    ).toEqual({
      shouldAbort: false,
      count: 1,
    });
    expect(
      guard.observe(callOutcome({ argsHash: "b", resultHash: "same", isError: true })),
    ).toEqual({
      shouldAbort: false,
      count: 1,
    });
    expect(
      guard.observe(callOutcome({ argsHash: "a", resultHash: "different", isError: true })),
    ).toEqual({
      shouldAbort: false,
      count: 1,
    });
  });

  it("respects disabled loop detection", () => {
    const guard = createLiveToolFailureLoopGuard({ criticalThreshold: 2 }, { enabled: false });

    expect(guard.observe(callOutcome({ isError: true })).shouldAbort).toBe(false);
    expect(guard.observe(callOutcome({ isError: true })).shouldAbort).toBe(false);
  });
});

describe("LiveToolFailureLoopError", () => {
  it("captures detector metadata", () => {
    const guard = createLiveToolFailureLoopGuard({ criticalThreshold: 1 });
    const verdict = guard.observe(callOutcome({ isError: true }));
    expect(verdict.shouldAbort).toBe(true);
    if (!verdict.shouldAbort) {
      throw new Error("verdict was expected to abort");
    }

    const err = LiveToolFailureLoopError.fromVerdict(verdict);
    expect(err).toBeInstanceOf(LiveToolFailureLoopError);
    expect(err.detector).toBe("live_tool_failure_loop");
    expect(err.count).toBe(1);
    expect(err.toolName).toBe("message");
  });
});
