/**
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
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
      reason: string;
    };

export const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
// Keep launch and later process observations consistent without naming an aliased tool.
export const EXEC_MANUAL_COLLECTION_FOLLOW_UP =
  "Automatic completion wake is disabled for this command. If the task needs this result, use poll with a timeout to collect it before ending the turn, unless another continuation is already arranged.";
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

const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;

export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function compactNotifyOutput(value: string) {
  return truncateWithMarker(normalizeNotifyOutput(value), DEFAULT_NOTIFY_SNIPPET_CHARS, {
    marker: "…",
    reserve: 1,
    trimEnd: false,
  });
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
    reason: joinExecFailureOutput(params.aggregated, reason),
  };
}

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
