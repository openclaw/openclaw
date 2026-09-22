import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import type { FailoverError } from "../failover-error.js";
import { cliBackendLog } from "./log.js";
import * as noOutputPolicy from "./no-output-timeout-policy.js";

const HOST_SUSPEND_TICK_THRESHOLD_MS = 45_000;
const WATCHDOG_TICK_MS = 1_000;

export type CliWatchdogClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => () => void;
};

export const defaultCliWatchdogClock: CliWatchdogClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

type CliPluginWatchdog = {
  noteOutput: () => void;
  reset: () => void;
  dispose: () => void;
};

export function createCliPluginWatchdog(
  params: {
    provider: string;
    model: string;
    sessionId: string;
    lane: string | undefined;
    overallTimeoutMs: number | undefined;
    noOutputTimeoutMs: number | undefined;
    useResume: boolean;
    getActiveAskUserDeadline?: () => number | undefined;
    activeToolCount: () => number;
    backgroundTaskCount: () => number;
    hasObservedActivity: () => boolean;
    hasReplayUnsafeActivity: () => boolean;
    onNoOutputTimeout: (error: FailoverError) => void;
    onOverallTimeout: () => void;
  },
  clock: CliWatchdogClock = defaultCliWatchdogClock,
): CliPluginWatchdog {
  const noOutputTimeoutMs = params.noOutputTimeoutMs;
  const overallTimeoutMs = params.overallTimeoutMs;
  let lastOutputAtMs = clock.now();
  let noOutputDeadlineMs = 0;
  let overallActiveRemainingMs = overallTimeoutMs;
  let timer: (() => void) | undefined;
  let lastTickAtMs = clock.now();
  let scheduledTickAtMs = lastTickAtMs;
  let disposed = false;

  const dispose = () => {
    disposed = true;
    timer?.();
    timer = undefined;
  };

  const scheduleTick = () => {
    if (disposed || (noOutputTimeoutMs === undefined && overallTimeoutMs === undefined)) {
      return;
    }
    const nowMs = clock.now();
    const nextDelayMs = Math.min(
      noOutputTimeoutMs === undefined ? Number.POSITIVE_INFINITY : noOutputDeadlineMs - nowMs,
      overallActiveRemainingMs === undefined
        ? Number.POSITIVE_INFINITY
        : overallActiveRemainingMs - Math.max(0, nowMs - lastTickAtMs),
      WATCHDOG_TICK_MS,
    );
    const nextTickAtMs = nowMs + Math.max(1, nextDelayMs);
    if (timer !== undefined && scheduledTickAtMs <= nextTickAtMs) {
      return;
    }
    timer?.();
    scheduledTickAtMs = nextTickAtMs;
    timer = clock.setTimeout(tick, nextTickAtMs - nowMs);
  };

  const tick = () => {
    timer = undefined;
    const nowMs = clock.now();
    const elapsedMs = Math.max(0, nowMs - lastTickAtMs);
    lastTickAtMs = nowMs;
    const suspendedMs =
      elapsedMs >= HOST_SUSPEND_TICK_THRESHOLD_MS ? Math.max(0, nowMs - scheduledTickAtMs) : 0;
    if (suspendedMs > 0) {
      const frozenStartMs = nowMs - suspendedMs;
      const creditedMs = Math.max(0, nowMs - Math.max(lastOutputAtMs, frozenStartMs));
      lastOutputAtMs += creditedMs;
      noOutputDeadlineMs += creditedMs;
      cliBackendLog.info(
        `cli watchdog credited timer gap: provider=${params.provider} model=${params.model} suspendedMs=${Math.round(suspendedMs)} creditedMs=${Math.round(creditedMs)}`,
      );
    }
    const activeElapsedMs = elapsedMs - suspendedMs;
    if (overallActiveRemainingMs !== undefined) {
      overallActiveRemainingMs -= activeElapsedMs;
      if (overallActiveRemainingMs <= 0) {
        dispose();
        params.onOverallTimeout();
        return;
      }
    }
    if (noOutputTimeoutMs !== undefined && nowMs >= noOutputDeadlineMs) {
      const quietDurationMs = nowMs - lastOutputAtMs;
      const askUserDeadline = params.getActiveAskUserDeadline?.();
      const decision = noOutputPolicy.resolveCliNoOutputTimeoutDecision({
        context: {
          provider: params.provider,
          model: params.model,
          sessionId: params.sessionId,
          lane: params.lane,
        },
        timeoutMs: noOutputTimeoutMs,
        quietDurationMs,
        cliTimeout: {
          mode: "no-output",
          timeoutSeconds: Math.round(quietDurationMs / 1000),
          observedActivity: params.hasObservedActivity(),
          activeToolCount: params.activeToolCount(),
          backgroundTaskCount: params.backgroundTaskCount(),
        },
        hasOutputText: false,
        useResume: params.useResume,
        hasReplayUnsafeActivity: params.hasReplayUnsafeActivity(),
        allowResumeControlOnlyRetry: true,
        outstandingWorkGraceMs:
          askUserDeadline === undefined
            ? BLOCKED_TOOL_CALL_ABORT_FLOOR_MS
            : Math.max(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS, askUserDeadline - lastOutputAtMs),
      });
      if (decision.deferMs !== undefined) {
        noOutputDeadlineMs = nowMs + decision.deferMs;
      } else {
        dispose();
        params.onNoOutputTimeout(decision.error);
        return;
      }
    }
    scheduleTick();
  };

  const reset = () => {
    if (disposed) {
      return;
    }
    if (noOutputTimeoutMs !== undefined) {
      const baselineDeadline = lastOutputAtMs + noOutputTimeoutMs;
      const askUserDeadline = params.getActiveAskUserDeadline?.();
      noOutputDeadlineMs =
        askUserDeadline === undefined
          ? baselineDeadline
          : Math.max(baselineDeadline, askUserDeadline);
    }
    scheduleTick();
  };

  return {
    noteOutput: () => {
      lastOutputAtMs = clock.now();
      reset();
    },
    reset,
    dispose,
  };
}
