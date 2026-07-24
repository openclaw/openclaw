import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortAndDrainEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(abort: () => void): RunHandle {
  return {
    abort,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => {},
  };
}

describe("abortAndDrainEmbeddedAgentRun", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    vi.useRealTimers();
  });

  it("does not abort or force-clear a replacement run during stuck recovery", async () => {
    vi.useFakeTimers();
    const staleAbort = vi.fn();
    const replacementAbort = vi.fn();
    const staleHandle = createRunHandle(staleAbort);
    const replacementHandle = createRunHandle(replacementAbort);
    setActiveEmbeddedRun("session-replaced-during-recovery", staleHandle, "agent:main");
    staleAbort.mockImplementation(() => {
      setActiveEmbeddedRun("session-replaced-during-recovery", replacementHandle, "agent:main");
    });

    const resultPromise = abortAndDrainEmbeddedAgentRun({
      sessionId: "session-replaced-during-recovery",
      sessionKey: "agent:main",
      settleMs: 100,
      forceClear: true,
      reason: "stuck_recovery",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      aborted: true,
      drained: true,
      forceCleared: false,
    });
    expect(staleAbort).toHaveBeenCalledOnce();
    expect(replacementAbort).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive("session-replaced-during-recovery")).toBe(true);
  });
});
