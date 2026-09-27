import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  QA_CHILD_STDERR_TAIL_BYTES,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
  readQaChildOutputTail,
} from "./child-output.js";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

export type QaScenarioCommandExecution = {
  signal?: AbortSignal;
  forwardParentSignals?: boolean;
  cleanupGraceMs?: number;
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (stream: "stderr" | "stdout", chunk: Buffer) => void;
  timeoutMs?: number;
};

export type QaScenarioCommandResult = {
  error?: Error;
  exitCode: number;
  failureMessage?: string;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: true;
  stderrTruncated?: true;
  // A requested cancellation/timeout is the primary result, not a child exit.
  // Preserve its later native tuple, or null when no exit was observed.
  observedExit?: { exitCode: number | null; signal: NodeJS.Signals | null } | null;
  forceKillRequested?: true;
  cleanupFailure?: Error;
};

type QaScenarioCommandTerminalResult = Pick<
  QaScenarioCommandResult,
  "exitCode" | "failureMessage" | "signal"
>;

const QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS = 2_000;
const QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS = 500;
let timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
let timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;

export function runQaScenarioCommandLifecycle(
  execution: QaScenarioCommandExecution,
): Promise<QaScenarioCommandResult> {
  return new Promise((resolve, reject) => {
    execution.signal?.throwIfAborted();
    const isWindows = process.platform === "win32";
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      detached: !isWindows,
      env: execution.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Logs are diagnostics, not native test verdicts: bound retention without
    // failing noisy commands or truncating their live onOutput stream.
    const stdout = createQaChildOutputCapture();
    const stderr = createQaChildOutputTail();
    const commandLabel = path.basename(execution.command);
    const onAbort = () => settlement.requestCleanup();
    const settlement = createQaPosixCommandSettlement({
      child,
      settlementFailureMessage: `${commandLabel} settlement failed`,
      forceKillAfterMs: execution.cleanupGraceMs ?? timeoutKillGraceMs,
      ...(isWindows
        ? {
            windowsCleanup: {
              signal: (signal: NodeJS.Signals) => {
                try {
                  if (
                    child.pid === undefined ||
                    !runQaWindowsTaskkill({ pid: child.pid, signal })
                  ) {
                    child.kill(signal);
                  }
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error : new Error(String(error));
                }
              },
            },
          }
        : {}),
      executionTimeoutMs: execution.timeoutMs,
      // A Lab-owned run retains its own interrupt handlers through report
      // publication; a child must not re-raise a process-wide signal first.
      forwardParentSignals: execution.forwardParentSignals ?? true,
      initialSignal: "SIGTERM",
      onSettled: (outcome) => {
        execution.signal?.removeEventListener("abort", onAbort);
        const primary = outcome.primary;
        const error =
          primary.type === "spawn-error" || primary.type === "stream-error"
            ? primary.error
            : undefined;
        if (error && child.pid === undefined) {
          reject(error);
          return;
        }
        // Once a child exists, an I/O error must retain its later exit and
        // cleanup facts; rejecting the error alone would erase those facts.
        const result: QaScenarioCommandTerminalResult = error
          ? { exitCode: 1, failureMessage: error.message, signal: null }
          : primary.type === "exit"
            ? {
                exitCode: primary.exitCode ?? (primary.signal ? 1 : 0),
                signal: primary.signal,
              }
            : primary.type === "parent-signal"
              ? {
                  exitCode: 1,
                  failureMessage: `${commandLabel} interrupted by ${primary.signal}`,
                  signal: primary.signal,
                }
              : primary.type === "manual"
                ? {
                    exitCode: outcome.observedExit?.exitCode || 1,
                    failureMessage: `${commandLabel} cancelled: ${String(execution.signal?.reason)}`,
                    signal: outcome.observedExit?.signal ?? null,
                  }
                : {
                    exitCode: 1,
                    failureMessage: `${commandLabel} timed out after ${execution.timeoutMs}ms`,
                    signal: null,
                  };
        const settlementFailure = outcome.settlementFailure?.message;
        resolve({
          ...result,
          ...(error ? { error } : {}),
          ...(settlementFailure && result.exitCode === 0 ? { exitCode: 1 } : {}),
          stdout: readQaChildOutput(stdout),
          stderr: readQaChildOutputTail(stderr),
          ...(primary.type !== "exit" ? { observedExit: outcome.observedExit ?? null } : {}),
          ...(outcome.forceKillRequested ? { forceKillRequested: true } : {}),
          ...(outcome.settlementFailure ? { cleanupFailure: outcome.settlementFailure } : {}),
          ...(stdout.exceeded ? { stdoutTruncated: true } : {}),
          ...(stderr.truncated ? { stderrTruncated: true } : {}),
          ...(settlementFailure
            ? result.failureMessage
              ? { failureMessage: `${result.failureMessage}; settlement: ${settlementFailure}` }
              : { failureMessage: settlementFailure }
            : {}),
        });
      },
      onStderrData: (chunk) => {
        const buffered = Buffer.from(chunk);
        appendQaChildOutputTail(stderr, buffered);
        execution.onOutput?.("stderr", buffered);
      },
      onStdoutData: (chunk) => {
        const buffered = Buffer.from(chunk);
        appendQaChildOutput(stdout, buffered);
        execution.onOutput?.("stdout", buffered);
      },
      processGroupId: isWindows ? undefined : child.pid,
      verifyAfterMs: timeoutForceSettleMs,
    });
    execution.signal?.addEventListener("abort", onAbort, { once: true });
    if (execution.signal?.aborted) {
      onAbort();
    }
  });
}

export function formatQaScenarioCommandOutput(result: QaScenarioCommandResult): string {
  return [
    result.stdoutTruncated
      ? `[stdout truncated to first ${QA_CHILD_STDOUT_MAX_BYTES} bytes]\n`
      : "",
    result.stdout,
    result.stderrTruncated
      ? `\n[stderr truncated to last ${QA_CHILD_STDERR_TAIL_BYTES} bytes]\n`
      : "",
    result.stderr,
  ].join("");
}

export function resetQaScenarioCommandCleanupTimings() {
  timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
  timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;
}

export function setQaScenarioCommandCleanupTimings(params: {
  forceSettleMs: number;
  killGraceMs: number;
}) {
  timeoutKillGraceMs = params.killGraceMs;
  timeoutForceSettleMs = params.forceSettleMs;
}
