/**
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
import type { RunExit, TerminationReason } from "../process/supervisor/types.js";

export type ExecProcessFailureKind =
  | "shell-command-not-found"
  | "shell-not-executable"
  | "overall-timeout"
  | "no-output-timeout"
  | "memory-limit"
  | "signal"
  | "aborted"
  | "runtime-error";

type ExecExitFailureKind = Exclude<ExecProcessFailureKind, "runtime-error">;

/** Normalized result of a spawned exec process. */
export type ExecProcessOutcome =
  | {
      status: "completed";
      exitCode: number;
      exitSignal: NodeJS.Signals | number | null;
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut: false;
      noOutputTimedOut?: boolean;
    }
  | {
      status: "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      noOutputTimedOut?: boolean;
      failureKind: ExecProcessFailureKind;
      oomScoreWrapperSelected?: boolean;
      /** Concise failure diagnostic, without the aggregated process output. */
      message: string;
      reason: string;
    };

export const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
// Keep launch and later process observations consistent without naming an aliased tool.
export const EXEC_MANUAL_COLLECTION_FOLLOW_UP =
  "Automatic completion wake is unavailable after ending this turn. If the task needs this result, use poll with a timeout to collect it before ending the turn, unless another continuation is already arranged.";
export const MAX_EXEC_YIELD_MS = 120_000;
const BACKGROUND_EXEC_FOLLOW_UP =
  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) to control it. New output while it runs does not start another turn. Ending the turn does not stop it; use process kill when it is no longer needed. This is not a saved, restartable automation.";
/** One waiting recipe for every surface that tells the agent how to wait. */
export const EXEC_WAIT_RECIPE =
  "To wait for a condition or a time, run one command that loops until it holds, exits non-zero on failure states and prints the result.";

type ExitWakeFacts = {
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  notifySessionTarget?: object;
  assertExitNotificationAcceptanceCurrent?: () => void;
  exitWakeAfterYield?: true;
  processActivity?: { deadlineAtMs?: number };
};

/**
 * Whether every exit, silent success included, wakes the conversation after the originating turn
 * ends. In a one-shot run the exit resumes the run only after sessions_yield awaits the command,
 * so the command's deadline must bound that wait.
 */
export function hasExitWake(session: ExitWakeFacts): boolean {
  return (
    session.notifyOnExit === true &&
    // An explicit tools.exec.notifyOnExitEmptySuccess=false opt-out leaves silent success unannounced.
    session.notifyOnExitEmptySuccess === true &&
    session.notifySessionTarget !== undefined &&
    (session.exitWakeAfterYield === true
      ? session.processActivity?.deadlineAtMs !== undefined
      : // Cron completion admission otherwise requires its originating run.
        session.assertExitNotificationAcceptanceCurrent === undefined)
  );
}

/** Exit-wake fact plus the condition for ending the turn, or undefined when the exit starts no turn. */
export function describeExitWake(session: ExitWakeFacts): string | undefined {
  if (!hasExitWake(session)) {
    return undefined;
  }
  return session.exitWakeAfterYield
    ? "This run resumes with its result when it exits, silent success included, if you call sessions_yield. If only waiting remains, call sessions_yield"
    : "Its exit wakes this conversation with the result, silent success included. If only waiting remains, end this turn";
}

/** Guidance for a running background handle, read when the handle is returned. */
export function buildBackgroundExecFollowUp(
  session: ExitWakeFacts,
  requestedYieldMs: number | undefined,
  otherRunning: string[],
): string {
  const exitWake = describeExitWake(session);
  return [
    (requestedYieldMs ?? 0) > MAX_EXEC_YIELD_MS && `yieldMs is capped at ${MAX_EXEC_YIELD_MS}.`,
    exitWake &&
      `${exitWake} now; do not poll it or start another command for the same result. ${EXEC_WAIT_RECIPE}`,
    otherRunning.length > 0 &&
      `Also running in this conversation: ${otherRunning.join("; ")}. Keep one command per awaited result.`,
    BACKGROUND_EXEC_FOLLOW_UP,
    !exitWake && EXEC_MANUAL_COLLECTION_FOLLOW_UP,
  ]
    .filter(Boolean)
    .join(" ");
}
export const EXEC_TIMEOUT_RETRY_GUIDANCE =
  "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun commands unless repeating them is safe. Use a higher timeout only when the command is known to be safe to retry.";

// Irreversible loss leads model-visible output so later head-preserving caps retain it.
export const EXEC_RETENTION_CAP_NOTE =
  "[earlier output was discarded at the retention cap and cannot be recovered]\n\n";

/** Render command output with a stable placeholder for empty output. */
export function renderExecOutputText(value: string | undefined): string {
  return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}

/** Render the authoritative process exit without inventing a successful code. */
export function renderExecExitLabel(exit: {
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
}): string {
  if (exit.exitSignal != null) {
    return `signal ${exit.exitSignal}`;
  }
  return exit.exitCode != null ? `code ${exit.exitCode}` : "unknown exit code";
}

/** Render the text shown in exec progress updates, including warnings first. */
export function renderExecUpdateText(params: { tailText?: string; warnings: string[] }): string {
  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  return warningText + renderExecOutputText(params.tailText);
}

/** Add retry-safety guidance only for supervisor timeout exits. */
export function appendExecTimeoutRetryGuidance(
  text: string,
  exitReason: TerminationReason | undefined,
): string {
  if (exitReason !== "overall-timeout" && exitReason !== "no-output-timeout") {
    return text;
  }
  return `${text}\n\n${EXEC_TIMEOUT_RETRY_GUIDANCE}`;
}

export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function joinExecFailureOutput(aggregated: string, reason: string) {
  return aggregated ? `${aggregated}\n\n${reason}` : reason;
}

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
  const failureKind: ExecExitFailureKind =
    params.exit.reason === "memory-limit"
      ? "memory-limit"
      : isShellFailure
        ? exitCode === 127
          ? "shell-command-not-found"
          : "shell-not-executable"
        : params.exit.reason === "overall-timeout"
          ? "overall-timeout"
          : params.exit.reason === "no-output-timeout"
            ? "no-output-timeout"
            : params.exit.exitSignal != null
              ? "signal"
              : "aborted";
  let reason: string;
  switch (failureKind) {
    case "memory-limit":
      reason =
        "Command killed for exceeding its host memory bound. Reduce concurrency or input size, or split the work.";
      break;
    case "shell-command-not-found":
      reason = "Command not found";
      break;
    case "shell-not-executable":
      reason = "Command not executable (permission denied)";
      break;
    case "overall-timeout": {
      const timeoutText =
        typeof params.timeoutSec === "number" && params.timeoutSec > 0
          ? `Command timed out after ${params.timeoutSec} seconds.`
          : "Command timed out.";
      const retryGuidance = appendExecTimeoutRetryGuidance(timeoutText, failureKind);
      reason = params.processContinuationAvailable
        ? `${retryGuidance}\n\nIf it should keep running, start it with exec background=true or yieldMs so OpenClaw can register a pollable process session. Do not rely on shell backgrounding with a trailing &.`
        : retryGuidance;
      break;
    }
    case "no-output-timeout":
      reason = appendExecTimeoutRetryGuidance("Command timed out waiting for output.", failureKind);
      break;
    case "signal":
      reason = `Command aborted by signal ${params.exit.exitSignal}`;
      break;
    case "aborted":
      reason = "Command aborted before exit code was captured";
      break;
    default:
      throw new Error("Unsupported exec failure kind");
  }
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
    message: reason,
    reason: joinExecFailureOutput(params.aggregated, reason),
  };
}

export function buildExecRuntimeErrorOutcome(params: {
  error: unknown;
  aggregated: string;
  durationMs: number;
}): ExecProcessOutcome {
  const message = String(params.error);
  return {
    status: "failed",
    exitCode: null,
    exitSignal: null,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: false,
    failureKind: "runtime-error",
    message,
    reason: joinExecFailureOutput(params.aggregated, message),
  };
}
