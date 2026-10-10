import type { MediaGenerationOperation } from "./media-generation-activity.js";

/** Build tool details that point callers at the already-active async task. */
export function buildSessionAsyncTaskStatusDetails(
  task: MediaGenerationOperation,
): Record<string, unknown> {
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
