import type { MediaGenerationOperation } from "./media-generation-activity.js";

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
