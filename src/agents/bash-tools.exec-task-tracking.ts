// Projects detached exec processes into the durable task ledger used by clients.
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BACKGROUND_EXEC_TASK_KIND } from "../tasks/background-exec-task-contract.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "../tasks/detached-task-runtime.js";
import { TASK_OUTPUT_TAIL_MAX_CHARS } from "../tasks/task-output-tail.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";

const log = createSubsystemLogger("agents/bash-exec-task-tracking");

function execTaskOutputTail(aggregated: string): string | undefined {
  // Strip escapes before masking so removed bytes cannot split a secret pattern;
  // keep newlines/tabs so the stored tail stays readable in output views.
  const cleaned = stripAnsi(aggregated).replace(/\p{Cc}/gu, (control) =>
    control === "\n" || control === "\t" ? control : "",
  );
  const sanitized = redactToolPayloadText(cleaned)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.length <= TASK_OUTPUT_TAIL_MAX_CHARS) {
    return sanitized;
  }
  // Keep the tail (most recent output); never split a surrogate pair at the boundary.
  const sliced = sanitized.slice(sanitized.length - TASK_OUTPUT_TAIL_MAX_CHARS + 1);
  const first = sliced.charCodeAt(0);
  return `…${first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced}`;
}

export type BackgroundExecTaskHandle = {
  taskId: string;
  runId: string;
  sessionKey: string;
};

export function createBackgroundExecTask(params: {
  processSessionId: string;
  command: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
}): BackgroundExecTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `exec:${params.processSessionId}`;
  try {
    // Redact the complete command before compacting it so truncated secrets cannot escape masking.
    const command = sanitizeTerminalText(
      redactToolPayloadText(params.command).replace(/\s+/gu, " "),
    ).trim();
    const label =
      truncateWithMarker(command, 120, { marker: "…", reserve: 1, trimEnd: true }) || "CLI command";
    const task = createRunningTaskRun({
      runtime: "cli",
      taskKind: BACKGROUND_EXEC_TASK_KIND,
      sourceId: params.processSessionId,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      agentId: params.agentId,
      requesterAgentId: params.agentId,
      runId,
      label,
      task: label,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
    });
    if (!task) {
      return null;
    }
    return { taskId: task.taskId, runId, sessionKey };
  } catch (error) {
    log.warn("Failed to register background exec task", {
      processSessionId: params.processSessionId,
      error,
    });
    return null;
  }
}

export function finalizeBackgroundExecTask(params: {
  handle: BackgroundExecTaskHandle | null;
  outcome: ExecProcessOutcome;
}): void {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const outputTail = execTaskOutputTail(params.outcome.aggregated);
  const status =
    params.outcome.status === "completed"
      ? params.outcome.exitCode === 0
        ? "succeeded"
        : "failed"
      : params.outcome.timedOut
        ? "timed_out"
        : params.outcome.exitReason === "manual-cancel"
          ? "cancelled"
          : "failed";
  try {
    finalizeTaskRunByRunId({
      runId: params.handle.runId,
      runtime: "cli",
      sessionKey: params.handle.sessionKey,
      status,
      endedAt,
      lastEventAt: endedAt,
      terminalSummary:
        status === "succeeded"
          ? "Command completed"
          : status === "failed"
            ? "Command failed"
            : "Command stopped",
      ...(status === "succeeded" ? { clearError: true } : { error: execTaskError(params.outcome) }),
      detail: {
        exitCode: params.outcome.exitCode,
        ...(params.outcome.exitSignal != null
          ? { exitSignal: String(params.outcome.exitSignal) }
          : {}),
        ...(params.outcome.status === "failed" ? { failureKind: params.outcome.failureKind } : {}),
        ...(outputTail ? { outputTail } : {}),
      },
    });
  } catch (error) {
    log.warn("Failed to finalize background exec task", {
      taskId: params.handle.taskId,
      runId: params.handle.runId,
      error,
    });
  }
}

function execTaskError(outcome: ExecProcessOutcome): string {
  if (outcome.status === "completed") {
    return `Command failed (exit code ${outcome.exitCode ?? "unknown"})`;
  }
  if (outcome.timedOut) {
    return "Command timed out";
  }
  if (outcome.exitReason === "manual-cancel") {
    return "Cancelled by operator";
  }
  return `Command failed (${outcome.failureKind})`;
}
