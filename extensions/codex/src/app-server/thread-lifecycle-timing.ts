import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createStageTimingTracker, formatStageTimings } from "openclaw/plugin-sdk/time-runtime";

type CodexThreadLifecycleTimingLogger = {
  isEnabled?: (level: "trace") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type CodexThreadLifecycleTimingOptions = {
  enabled?: boolean;
  now?: () => number;
  log?: CodexThreadLifecycleTimingLogger;
};

export type CodexThreadLifecycleTimingTracker = ReturnType<
  typeof createCodexThreadLifecycleTimingTracker
>;

export function createCodexThreadLifecycleTimingTracker(
  options: CodexThreadLifecycleTimingOptions = {},
) {
  const log = options.log ?? embeddedAgentLog;

  const timing = createStageTimingTracker(options.now ?? Date.now);
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
      const detailed = options.enabled || log.isEnabled?.("trace");
      const totalThresholdMs = detailed ? 1_000 : 10_000;
      const stageThresholdMs = detailed ? 500 : 5_000;
      const shouldWarn =
        totalMs >= totalThresholdMs || spans.some((span) => span.durationMs >= stageThresholdMs);
      if (!shouldWarn && !log.isEnabled?.("trace")) {
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
        log.warn(message, meta);
      } else {
        log.trace(message, meta);
      }
    },
  };
}
