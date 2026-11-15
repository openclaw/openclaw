import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { addSafeTimeoutDelayGraceMs } from "../utils/timer-delay.js";
import { resolveRequestedExecTarget } from "./bash-tools.exec-target.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";

function resolveExecDefaultTimeoutSec(timeoutSec?: number): number {
  return timeoutSec && timeoutSec > 0 ? timeoutSec : 1800;
}

/**
 * Default lifetimes for ordinary commands and for deliberate services. A service
 * has no built-in lifetime; only a configured or explicit timeout applies. In a
 * one-shot run (subagent or cron) that can await the command with sessions_yield,
 * the default still bounds that wait.
 */
export function resolveExecTimeoutDefaults(
  defaults?: Pick<
    ExecToolDefaults,
    | "timeoutSec"
    | "sessionsYieldAvailabilityRef"
    | "notifySessionKey"
    | "runSessionKey"
    | "sessionKey"
  >,
): [number, (hiddenSubagent: boolean) => number | null] {
  const timeoutSec = defaults?.timeoutSec;
  const defaultTimeoutSec = resolveExecDefaultTimeoutSec(timeoutSec);
  const runKey = defaults?.notifySessionKey ?? defaults?.runSessionKey ?? defaults?.sessionKey;
  const oneShotKey = isSubagentSessionKey(runKey) || isCronRunSessionKey(runKey);
  return [
    defaultTimeoutSec,
    (hiddenSubagent) =>
      (hiddenSubagent || oneShotKey) && defaults?.sessionsYieldAvailabilityRef?.value === true
        ? defaultTimeoutSec
        : timeoutSec && timeoutSec > 0
          ? timeoutSec
          : null,
  ];
}

export function resolveNodeExecTimeouts(
  timeoutSec: number | null | undefined,
  defaultTimeoutSec: number,
): { runTimeoutMs: number; invokeDeadlineMs: number; invokeWaitMs: number } {
  const runTimeoutSec =
    typeof timeoutSec === "number" && Number.isFinite(timeoutSec) ? timeoutSec : defaultTimeoutSec;
  // Zero disables only the program timer; node invocation still has a bounded wait.
  const baseTimeoutSec =
    Number.isFinite(runTimeoutSec) && runTimeoutSec > 0 ? runTimeoutSec : defaultTimeoutSec;
  const invokeDeadlineMs =
    !Number.isFinite(baseTimeoutSec) || baseTimeoutSec <= 0
      ? 10_000
      : Math.max(10_000, addSafeTimeoutDelayGraceMs(baseTimeoutSec * 1000, 5_000));
  return {
    runTimeoutMs:
      Number.isFinite(runTimeoutSec) && runTimeoutSec > 0
        ? addSafeTimeoutDelayGraceMs(runTimeoutSec * 1000, 0, { minMs: 0 })
        : 0,
    invokeDeadlineMs,
    // Both deadlines saturate together at the safe timer ceiling.
    invokeWaitMs: addSafeTimeoutDelayGraceMs(invokeDeadlineMs, 5_000),
  };
}

export function createExecToolExecutionTimeoutResolver(
  defaults?: Pick<ExecToolDefaults, "host" | "timeoutSec">,
): (args: unknown) => number | undefined {
  const defaultTimeoutSec = resolveExecDefaultTimeoutSec(defaults?.timeoutSec);
  const defaultHost = defaults?.host;
  return (args) => {
    const params = asNonArrayRecord(args);
    const requestedHost = resolveRequestedExecTarget(params);
    const host = requestedHost && requestedHost !== "auto" ? requestedHost : defaultHost;
    if (host !== "node") {
      return undefined;
    }
    return resolveNodeExecTimeouts(
      typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined,
      defaultTimeoutSec,
    ).invokeWaitMs;
  };
}
