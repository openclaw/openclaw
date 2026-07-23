// Handle-identity guards for stuck-session recovery: abort/drain must not
// touch a run re-registered under the same session id after a stale capture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunHandleSessionId,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    runId?: string;
  } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    runId: overrides.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
}

describe("embedded-agent runner handle identity", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("scopes a single-session abort to a captured handle", () => {
    const abortCurrent = vi.fn();
    const currentHandle = createRunHandle({ abort: abortCurrent });
    setActiveEmbeddedRun("session-identity-abort", currentHandle);

    // A captured handle that no longer matches the registered run must not abort
    // the run a retry path re-registered under the same session id.
    expect(abortEmbeddedAgentRun("session-identity-abort", { handle: createRunHandle() })).toBe(
      false,
    );
    expect(abortCurrent).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive("session-identity-abort")).toBe(true);

    expect(abortEmbeddedAgentRun("session-identity-abort", { handle: currentHandle })).toBe(true);
    expect(abortCurrent).toHaveBeenCalledTimes(1);
  });

  it("leaves a re-registered run alone when recovery carries a stale handle", async () => {
    vi.useFakeTimers();
    try {
      const abortCurrent = vi.fn();
      const currentHandle = createRunHandle({ abort: abortCurrent });
      setActiveEmbeddedRun("session-reregistered", currentHandle, "agent:main");

      // Stuck-session watchdog captured a handle that a retry path has since
      // replaced; recovery must neither abort nor force-clear the new run.
      const resultPromise = abortAndDrainEmbeddedAgentRun({
        sessionId: "session-reregistered",
        sessionKey: "agent:main",
        settleMs: 50,
        forceClear: true,
        reason: "stuck_recovery",
        handle: createRunHandle(),
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;

      expect(result).toEqual({ aborted: false, drained: false, forceCleared: false });
      expect(abortCurrent).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive("session-reregistered")).toBe(true);
      expect(resolveActiveEmbeddedRunHandleSessionId("agent:main")).toBe("session-reregistered");
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
