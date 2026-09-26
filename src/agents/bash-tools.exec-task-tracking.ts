// Projects detached exec processes into the durable task ledger used by clients.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { backgroundCommandTaskContent } from "../tasks/background-command-task-content.js";
import { BACKGROUND_EXEC_TASK_KIND } from "../tasks/background-exec-task-contract.js";
import type { DetachedTaskTerminalState } from "../tasks/detached-task-runtime-contract.js";
import { prepareRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { backgroundCommandTaskSummary } from "../tasks/task-content.js";
import { getTaskRunOwner } from "../tasks/task-run-owner.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-types.js";

const log = createSubsystemLogger("agents/bash-exec-task-tracking");

export type BackgroundExecTaskHandle = {
  taskId: string;
  runId: string;
  sessionKey: string;
  finalize: (terminal: DetachedTaskTerminalState) => void | Promise<void>;
};

export function createBackgroundExecTask(params: {
  processSessionId: string;
  command: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  assertCurrent: () => void;
}): BackgroundExecTaskHandle | null | Promise<BackgroundExecTaskHandle | null> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `exec:${params.processSessionId}`;
  const failed = (error: unknown) => {
    log.warn("Failed to register background exec task", {
      processSessionId: params.processSessionId,
      error,
    });
    return null;
  };
  try {
    const content = backgroundCommandTaskContent(params.command);
    const prepared = prepareRunningTaskRun(
      {
        runtime: "cli",
        taskKind: BACKGROUND_EXEC_TASK_KIND,
        sourceId: params.processSessionId,
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
        scopeKind: "session",
        agentId: params.agentId,
        requesterAgentId: params.agentId,
        runId,
        ...content,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: params.startedAt,
        lastEventAt: params.startedAt,
      },
      params.assertCurrent,
    );
    if (prepared.kind === "legacy") {
      return prepared.task
        ? {
            taskId: prepared.task.taskId,
            runId,
            sessionKey,
            finalize(terminal) {
              params.assertCurrent();
              prepared.finalizeRun({ ...terminal, runId, runtime: "cli", sessionKey });
            },
          }
        : null;
    }
    return prepared.create().then(
      (receipt) =>
        receipt
          ? {
              taskId: receipt.task.taskId,
              runId,
              sessionKey,
              finalize: (terminal: DetachedTaskTerminalState) =>
                receipt.finalizeActive(terminal, (task) => {
                  params.assertCurrent();
                  return task.taskId === receipt.task.taskId && !getTaskRunOwner(task);
                }),
            }
          : null,
      failed,
    );
  } catch (error) {
    return failed(error);
  }
}

export function finalizeBackgroundExecTask(params: {
  handle: BackgroundExecTaskHandle | null;
  outcome: ExecProcessOutcome;
}): void | Promise<void> {
  const handle = params.handle;
  if (!handle) {
    return;
  }
  const failed = (error: unknown) => {
    log.warn("Failed to finalize background exec task", {
      taskId: handle.taskId,
      runId: handle.runId,
      error,
    });
  };
  const endedAt = Date.now();
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
    const pending = handle.finalize({
      status,
      endedAt,
      lastEventAt: endedAt,
      terminalSummary: backgroundCommandTaskSummary(status),
      ...(status === "succeeded" ? { clearError: true } : { error: execTaskError(params.outcome) }),
      detail: {
        exitCode: params.outcome.exitCode,
        ...(params.outcome.exitSignal != null
          ? { exitSignal: String(params.outcome.exitSignal) }
          : {}),
        ...(params.outcome.status === "failed" ? { failureKind: params.outcome.failureKind } : {}),
      },
    });
    return pending?.catch(failed);
  } catch (error) {
    failed(error);
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
