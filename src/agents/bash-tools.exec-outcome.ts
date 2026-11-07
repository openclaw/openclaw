import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { RunExit, TerminationReason } from "../process/supervisor/types.js";
import { appendOutput, type ProcessSession } from "./bash-process-registry.js";
import { appendExecTimeoutRetryGuidance, renderExecOutputText } from "./bash-tools.exec-output.js";
import type { ExecExitFailureKind, ExecProcessOutcome } from "./bash-tools.exec-types.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

const UNCONFIRMED_DESCENDANT_CLEANUP_NOTE =
  "OpenClaw could not confirm that every process started by this command stopped; a detached process (such as a daemon or tmux server) may still be running. Use background: true for long-running services.";

function joinExecFailureOutput(aggregated: string, reason: string) {
  return aggregated ? `${aggregated}\n\n${reason}` : reason;
}

function classifyExecFailureKind(params: {
  exitReason: TerminationReason;
  exitCode: number;
  isShellFailure: boolean;
  exitSignal: NodeJS.Signals | number | null;
}): ExecExitFailureKind {
  if (params.isShellFailure) {
    return params.exitCode === 127 ? "shell-command-not-found" : "shell-not-executable";
  }
  if (params.exitReason === "overall-timeout") {
    return "overall-timeout";
  }
  if (params.exitReason === "no-output-timeout") {
    return "no-output-timeout";
  }
  if (params.exitSignal != null) {
    return "signal";
  }
  return "aborted";
}

/** Formats a user-facing reason for a failed exec process exit. */
function formatExecFailureReason(params: {
  failureKind: ExecExitFailureKind;
  exitSignal: NodeJS.Signals | number | null;
  timeoutSec: number | null | undefined;
  processContinuationAvailable: boolean;
}): string {
  switch (params.failureKind) {
    case "shell-command-not-found":
      return "Command not found";
    case "shell-not-executable":
      return "Command not executable (permission denied)";
    case "overall-timeout": {
      const timeoutText =
        typeof params.timeoutSec === "number" && params.timeoutSec > 0
          ? `Command timed out after ${params.timeoutSec} seconds.`
          : "Command timed out.";
      const retryGuidance = appendExecTimeoutRetryGuidance(timeoutText, params.failureKind);
      return params.processContinuationAvailable
        ? `${retryGuidance}\n\nIf it should keep running, start it with exec background=true or yieldMs so OpenClaw can register a pollable process session. Do not rely on shell backgrounding with a trailing &.`
        : retryGuidance;
    }
    case "no-output-timeout":
      return appendExecTimeoutRetryGuidance(
        "Command timed out waiting for output.",
        params.failureKind,
      );
    case "signal":
      return `Command aborted by signal ${params.exitSignal}`;
    case "aborted":
      return "Command aborted before exit code was captured";
  }
  throw new Error("Unsupported exec failure kind");
}

/** Converts a supervisor exit record into a normalized exec process outcome. */
export function buildExecExitOutcome(params: {
  exit: RunExit;
  aggregated: string;
  durationMs: number;
  timeoutSec: number | null | undefined;
  processContinuationAvailable: boolean;
}): ExecProcessOutcome {
  const exitCode = params.exit.exitCode ?? 0;
  const isNormalExit = params.exit.reason === "exit";
  const isShellFailure = exitCode === 126 || exitCode === 127;
  const status: ExecProcessOutcome["status"] =
    isNormalExit && !isShellFailure ? "completed" : "failed";
  if (status === "completed") {
    const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
    return {
      status: "completed",
      exitCode,
      exitSignal: params.exit.exitSignal,
      exitReason: params.exit.reason,
      durationMs: params.durationMs,
      aggregated: (exitMsg ? renderExecOutputText(params.aggregated) : params.aggregated) + exitMsg,
      timedOut: false,
      noOutputTimedOut: params.exit.noOutputTimedOut,
    };
  }
  const failureKind = classifyExecFailureKind({
    exitReason: params.exit.reason,
    exitCode,
    isShellFailure,
    exitSignal: params.exit.exitSignal,
  });
  const reason = formatExecFailureReason({
    failureKind,
    exitSignal: params.exit.exitSignal,
    timeoutSec: params.timeoutSec,
    processContinuationAvailable: params.processContinuationAvailable,
  });
  return {
    status: "failed",
    exitCode: params.exit.exitCode,
    exitSignal: params.exit.exitSignal,
    exitReason: params.exit.reason,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: params.exit.timedOut,
    noOutputTimedOut: params.exit.noOutputTimedOut,
    failureKind,
    oomScoreWrapperSelected: params.exit.oomScoreWrapperSelected,
    reason: joinExecFailureOutput(params.aggregated, reason),
  };
}

/** Converts spawn/runtime errors into a normalized failed exec outcome. */
export function buildExecRuntimeErrorOutcome(params: {
  error: unknown;
  aggregated: string;
  durationMs: number;
}): ExecProcessOutcome {
  return {
    status: "failed",
    exitCode: null,
    exitSignal: null,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: false,
    failureKind: "runtime-error",
    reason: joinExecFailureOutput(params.aggregated, String(params.error)),
  };
}

/** Preserve completed root exits while recording unconfirmed descendant cleanup. */
export function buildExecDescendantCleanupOutcome(
  session: ProcessSession,
  outcome: ExecProcessOutcome,
  error: unknown,
): ExecProcessOutcome {
  // Recheck stop intent after all awaited finalization, not just root settlement.
  if (outcome.status !== "completed" || session.cancellationRequested) {
    throw error;
  }
  session.finalizationFailed = true;
  recordAgentCleanupFailure();
  logWarn(
    `exec: descendant cleanup after completion was not confirmed (${redactToolPayloadText(formatErrorMessage(error))}).`,
  );
  appendOutput(session, "stderr", `\n${UNCONFIRMED_DESCENDANT_CLEANUP_NOTE}\n`);
  return {
    ...outcome,
    aggregated: joinExecFailureOutput(outcome.aggregated, UNCONFIRMED_DESCENDANT_CLEANUP_NOTE),
  };
}

/** Record finalization failure without discarding an already failed process result. */
export function buildExecFinalizationErrorOutcome(
  session: ProcessSession,
  outcome: ExecProcessOutcome,
  error: unknown,
  startedAt: number,
): ExecProcessOutcome {
  let finalOutcome: ExecProcessOutcome;
  session.finalizationFailed = true;
  recordAgentCleanupFailure();
  const detail = redactToolPayloadText(formatErrorMessage(error));
  if (outcome.status === "completed") {
    finalOutcome = buildExecRuntimeErrorOutcome({
      error: detail,
      aggregated: session.aggregated.trim(),
      durationMs: Date.now() - startedAt,
    });
  } else {
    finalOutcome = { ...outcome, reason: joinExecFailureOutput(outcome.reason, detail) };
    logWarn(`exec: finalization after process failure failed (${detail}).`);
  }
  // Failed commands must retain cleanup failures in the same bounded, redacted output.
  appendOutput(session, "stderr", `\n${detail}\n`);
  finalOutcome.aggregated = session.aggregated.trim();
  return finalOutcome;
}
