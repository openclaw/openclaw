import { randomUUID } from "node:crypto";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
} from "../../context-engine/types.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { enqueueCommandInLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  startTaskRunByRunId,
} from "../../tasks/task-executor.js";
import {
  findTaskByRunId,
  markTaskTerminalById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "../../tasks/task-registry.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import { resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import {
  rewriteTranscriptEntriesInSessionFile,
  rewriteTranscriptEntriesInSessionManager,
} from "./transcript-rewrite.js";

const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_TASK_LABEL = "Context engine turn maintenance";
const TURN_MAINTENANCE_TASK_TASK = "Deferred context-engine maintenance after turn.";
const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_WAIT_POLL_MS = 100;
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
const activeDeferredTurnMaintenanceRuns = new Map<string, Promise<void>>();

function normalizeSessionKey(sessionKey?: string): string | undefined {
  return normalizeOptionalString(sessionKey) || undefined;
}

function resolveDeferredTurnMaintenanceLane(sessionKey: string): string {
  return `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
}

function buildTurnMaintenanceTaskDescriptor(params: { sessionKey: string }) {
  const runId = `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(
    0,
    8,
  )}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
    sourceId: TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: TURN_MAINTENANCE_TASK_LABEL,
    task: TURN_MAINTENANCE_TASK_TASK,
    notifyPolicy: "silent",
    deliveryStatus: "pending",
    preferMetadata: true,
  });
}

function promoteTurnMaintenanceTaskVisibility(params: {
  sessionKey: string;
  runId: string;
  notifyPolicy: "done_only" | "state_changes";
}) {
  const task = findTaskByRunId(params.runId);
  if (!task) {
    return createQueuedTaskRun({
      runtime: "acp",
      taskKind: TURN_MAINTENANCE_TASK_KIND,
      sourceId: TURN_MAINTENANCE_TASK_KIND,
      requesterSessionKey: params.sessionKey,
      ownerKey: params.sessionKey,
      scopeKind: "session",
      runId: params.runId,
      label: TURN_MAINTENANCE_TASK_LABEL,
      task: TURN_MAINTENANCE_TASK_TASK,
      notifyPolicy: params.notifyPolicy,
      deliveryStatus: "pending",
      preferMetadata: true,
    });
  }
  setTaskRunDeliveryStatusByRunId({
    runId: params.runId,
    runtime: "acp",
    sessionKey: params.sessionKey,
    deliveryStatus: "pending",
  });
  if (task.notifyPolicy !== params.notifyPolicy) {
    updateTaskNotifyPolicyById({
      taskId: task.taskId,
      notifyPolicy: params.notifyPolicy,
    });
  }
  return findTaskByRunId(params.runId) ?? task;
}

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
export function buildContextEngineMaintenanceRuntimeContext(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  allowDeferredCompactionExecution?: boolean;
}): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      if (params.sessionManager) {
        return rewriteTranscriptEntriesInSessionManager({
          sessionManager: params.sessionManager,
          replacements: request.replacements,
        });
      }
      return await rewriteTranscriptEntriesInSessionFile({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        request,
      });
    },
  };
}

async function executeContextEngineMaintenance(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode: "foreground" | "background";
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      runtimeContext: params.runtimeContext,
      allowDeferredCompactionExecution: params.executionMode === "background",
    }),
  });
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}

async function runDeferredTurnMaintenanceWorker(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  runId: string;
}): Promise<void> {
  let surfacedUserNotice = false;
  let longRunningTimer: ReturnType<typeof setTimeout> | null = null;
  const surfaceMaintenanceUpdate = (summary: string, eventSummary: string) => {
    promoteTurnMaintenanceTaskVisibility({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy: "state_changes",
    });
    surfacedUserNotice = true;
    recordTaskRunProgressByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      lastEventAt: Date.now(),
      progressSummary: summary,
      eventSummary,
    });
  };

  try {
    const sessionLane = resolveSessionLane(params.sessionKey);
    const startedWaitingAt = Date.now();
    let lastWaitNoticeAt = 0;

    while (getQueueSize(sessionLane) > 0) {
      const now = Date.now();
      if (lastWaitNoticeAt === 0 || now - lastWaitNoticeAt >= TURN_MAINTENANCE_LONG_WAIT_MS) {
        lastWaitNoticeAt = now;
        if (now - startedWaitingAt >= TURN_MAINTENANCE_LONG_WAIT_MS) {
          surfaceMaintenanceUpdate(
            "Waiting for the session lane to go idle.",
            surfacedUserNotice
              ? "Still waiting for the session lane to go idle."
              : "Deferred maintenance is waiting for the session lane to go idle.",
          );
        }
      }
      await sleepWithAbort(TURN_MAINTENANCE_WAIT_POLL_MS);
    }

    const runningAt = Date.now();
    startTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      startedAt: runningAt,
      lastEventAt: runningAt,
      progressSummary: "Running deferred maintenance.",
      eventSummary: "Starting deferred maintenance.",
    });
    longRunningTimer = setTimeout(() => {
      try {
        surfaceMaintenanceUpdate(
          "Deferred maintenance is still running.",
          "Deferred maintenance is still running.",
        );
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);

    const result = await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      executionMode: "background",
    });
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }

    const endedAt = Date.now();
    completeTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: result?.changed
        ? "Deferred maintenance completed with transcript changes."
        : "Deferred maintenance completed.",
      terminalSummary: result?.changed
        ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.`
        : "No transcript changes were needed.",
    });
  } catch (err) {
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      promoteTurnMaintenanceTaskVisibility({
        sessionKey: params.sessionKey,
        runId: params.runId,
        notifyPolicy: "done_only",
      });
    }
    failTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: reason,
      progressSummary: "Deferred maintenance failed.",
      terminalSummary: reason,
    });
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  }
}

function scheduleDeferredTurnMaintenance(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
}): void {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  if (activeDeferredTurnMaintenanceRuns.has(sessionKey)) {
    return;
  }

  const existingTask = findActiveSessionTask({
    sessionKey,
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
  });
  const reusableTask = existingTask?.runId?.trim() ? existingTask : undefined;
  if (existingTask && !reusableTask) {
    updateTaskNotifyPolicyById({
      taskId: existingTask.taskId,
      notifyPolicy: "silent",
    });
    markTaskTerminalById({
      taskId: existingTask.taskId,
      status: "cancelled",
      endedAt: Date.now(),
      terminalSummary: "Superseded by refreshed deferred maintenance task.",
    });
  }
  const task =
    reusableTask ??
    buildTurnMaintenanceTaskDescriptor({
      sessionKey,
    });
  log.info(
    `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${resolveDeferredTurnMaintenanceLane(sessionKey)}`,
  );

  const runPromise = enqueueCommandInLane(
    resolveDeferredTurnMaintenanceLane(sessionKey),
    async () =>
      runDeferredTurnMaintenanceWorker({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey,
        sessionFile: params.sessionFile,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
        runId: task.runId!,
      }),
  );
  const trackedPromise = runPromise
    .catch((err) => {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    })
    .finally(() => {
      activeDeferredTurnMaintenanceRuns.delete(sessionKey);
    });
  activeDeferredTurnMaintenanceRuns.set(sessionKey, trackedPromise);
  void trackedPromise;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(params: {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode?: "foreground" | "background";
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine?.maintain !== "function") {
    return undefined;
  }

  const executionMode = params.executionMode ?? "foreground";
  const shouldDefer =
    params.reason === "turn" &&
    executionMode !== "background" &&
    params.contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    try {
      scheduleDeferredTurnMaintenance({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? params.sessionId,
        sessionFile: params.sessionFile,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
      });
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    }
    return undefined;
  }

  try {
    return await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: params.reason,
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      executionMode,
    });
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
