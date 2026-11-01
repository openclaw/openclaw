import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createStageTimingTracker, formatStageTimings } from "openclaw/plugin-sdk/time-runtime";

export type CodexThreadLifecycleTimingTracker = ReturnType<
  typeof createCodexThreadLifecycleTimingTracker
>;

export function createCodexThreadLifecycleTimingTracker(enabled: boolean) {
  const timing = createStageTimingTracker();
  let didLog = false;
  return {
    measure: timing.measure,
    measureSync: timing.measureSync,
    mark(name: string) {
      // Lifecycle marks are instantaneous spans, not time since the previous mark.
      timing.measureSync(name, () => undefined);
    },
    logSummary(params: {
      runId: string;
      sessionId: string;
      sessionKey?: string;
      action: "started" | "resumed" | "forked" | "rotated";
      threadId?: string;
    }) {
      if (didLog) {
        return;
      }
      const { totalMs, stages: spans } = timing.snapshot();
      const detailed = enabled || embeddedAgentLog.isEnabled("trace");
      const totalThresholdMs = detailed ? 1_000 : 10_000;
      const stageThresholdMs = detailed ? 500 : 5_000;
      const shouldWarn =
        totalMs >= totalThresholdMs || spans.some((span) => span.durationMs >= stageThresholdMs);
      if (!shouldWarn && !embeddedAgentLog.isEnabled("trace")) {
        return;
      }
      didLog = true;
      const message =
        `[trace:codex-app-server] thread lifecycle: runId=${params.runId} ` +
        `sessionId=${params.sessionId} sessionKey=${params.sessionKey ?? "unknown"} ` +
        `action=${params.action} totalMs=${totalMs} stages=${formatStageTimings(spans)}`;
      const meta = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        threadId: params.threadId,
        totalMs,
        spans,
      };
      if (shouldWarn) {
        embeddedAgentLog.warn(message, meta);
      } else {
        embeddedAgentLog.trace(message, meta);
      }
    },
  };
}
