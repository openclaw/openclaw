import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../tasks/task-registry.types.js";

const DEFAULT_ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

export function findActiveSessionTask(params: {
  sessionKey?: string;
  runtime?: TaskRuntime;
  taskKind?: string;
  statuses?: ReadonlySet<TaskStatus>;
  sourceIdPrefix?: string;
}): TaskRecord | null {
  const normalizedSessionKey = params.sessionKey?.trim();
  if (!normalizedSessionKey) {
    return null;
  }
  const statuses = params.statuses ?? DEFAULT_ACTIVE_STATUSES;
  const taskKind = params.taskKind?.trim();
  const sourceIdPrefix = params.sourceIdPrefix?.trim();
  const matches = listTasksForOwnerKey(normalizedSessionKey).filter((task) => {
    if (task.scopeKind !== "session") {
      return false;
    }
    if (params.runtime && task.runtime !== params.runtime) {
      return false;
    }
    if (!statuses.has(task.status)) {
      return false;
    }
    if (taskKind && task.taskKind !== taskKind) {
      return false;
    }
    if (sourceIdPrefix) {
      const sourceId = task.sourceId?.trim() ?? "";
      if (sourceId !== sourceIdPrefix && !sourceId.startsWith(`${sourceIdPrefix}:`)) {
        return false;
      }
    }
    return true;
  });
  if (matches.length === 0) {
    return null;
  }
  return matches.find((task) => task.status === "running") ?? matches[0] ?? null;
}

export function buildSessionAsyncTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return {
    async: true,
    active: true,
    existingTask: true,
    status: task.status,
    task: {
      taskId: task.taskId,
      ...(task.runId ? { runId: task.runId } : {}),
    },
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
  };
}
