import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessSessionRuntimeParamsV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createStageTimingTracker, formatStageTimings } from "openclaw/plugin-sdk/time-runtime";
import type { CodexAppServerContextEngineBinding } from "./session-binding-record-codec.js";

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

/** Logs a ready thread's context-engine binding write and closes the lifecycle timing summary. */
export function recordCodexThreadReady(
  params: {
    params: Pick<AgentHarnessSessionRuntimeParamsV1, "runId" | "sessionId" | "sessionKey">;
  },
  context: {
    contextEngineBinding?: CodexAppServerContextEngineBinding;
    lifecycleTiming: Pick<CodexThreadLifecycleTimingTracker, "mark" | "logSummary">;
  },
  threadId: string,
  action: "resumed" | "rotated" | "started",
): void {
  const { contextEngineBinding, lifecycleTiming } = context;
  const event = {
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    threadId,
    action,
  };
  if (contextEngineBinding) {
    embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
      ...event,
      engineId: contextEngineBinding.engineId,
      epoch: contextEngineBinding.projection?.epoch,
      fingerprint: contextEngineBinding.projection?.fingerprint,
    });
  }
  lifecycleTiming.mark("thread-ready");
  lifecycleTiming.logSummary({ runId: params.params.runId, ...event });
}
