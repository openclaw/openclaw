import { expect, it } from "vitest";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import { resolveCliNoOutputTimeoutDecision } from "./no-output-timeout-policy.js";

it("never shortens a configured no-output budget longer than the outstanding-work floor", () => {
  const decision = resolveCliNoOutputTimeoutDecision({
    context: {
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      sessionId: "s1",
      lane: undefined,
    },
    timeoutMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS * 2,
    quietDurationMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    cliTimeout: {
      mode: "no-output",
      timeoutSeconds: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS / 1000,
      observedActivity: true,
      activeToolCount: 0,
      backgroundTaskCount: 0,
      compactionActive: true,
    },
    hasOutputText: false,
    useResume: false,
    hasReplayUnsafeActivity: true,
    outstandingWorkGraceMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  });
  expect(decision.deferMs).toBe(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
});
