import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  findDuplicateGuardMediaGenerationTaskForSession,
  getMediaGenerationTaskProviderId,
  isActiveMediaGenerationTask,
  listActiveMediaGenerationTasksForSession,
} from "./media-generation-task-status-shared.js";

export const IMAGE_GENERATION_TASK_KIND = "image_generation";
const IMAGE_GENERATION_SOURCE_PREFIX = "image_generate";
const RECENT_IMAGE_GENERATION_DUPLICATE_GUARD_MS = 2 * 60_000;

export function isActiveImageGenerationTask(task: TaskRecord): boolean {
  return isActiveMediaGenerationTask({
    task,
    taskKind: IMAGE_GENERATION_TASK_KIND,
  });
}

export function getImageGenerationTaskProviderId(task: TaskRecord): string | undefined {
  return getMediaGenerationTaskProviderId(task, IMAGE_GENERATION_SOURCE_PREFIX);
}

export function findActiveImageGenerationTaskForSession(
  sessionKey?: string,
  params?: { prompt?: string },
): TaskRecord | undefined {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    taskLabel: params?.prompt,
  });
}

export function listActiveImageGenerationTasksForSession(sessionKey?: string): TaskRecord[] {
  return listActiveMediaGenerationTasksForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
  });
}

export function findDuplicateGuardImageGenerationTaskForSession(
  sessionKey?: string,
  params?: { prompt?: string; requestKey?: string },
): TaskRecord | undefined {
  return findDuplicateGuardMediaGenerationTaskForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    taskLabel: params?.prompt,
    requestKey: params?.requestKey,
    maxAgeMs: RECENT_IMAGE_GENERATION_DUPLICATE_GUARD_MS,
  });
}

export function buildImageGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    task,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
  });
}

export function buildImageGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    task,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    nounLabel: "Image generation",
    toolName: "image_generate",
    completionLabel: "image",
    duplicateGuard: params?.duplicateGuard,
  });
}

export function buildImageGenerationTasksStatusText(tasks: readonly TaskRecord[]): string {
  if (tasks.length === 0) {
    return "No active image generation task is currently running for this session.";
  }
  if (tasks.length === 1) {
    return buildImageGenerationTaskStatusText(tasks[0]);
  }
  const lines = [
    `${tasks.length} active image generation tasks are currently running for this session.`,
    ...tasks.map((task) => {
      const provider = getImageGenerationTaskProviderId(task);
      const prompt = task.task.trim();
      const parts = [
        `- Task ${task.taskId} is ${task.status}${provider ? ` with ${provider}` : ""}.`,
        prompt ? `Prompt: ${prompt}.` : null,
        task.progressSummary ? `Progress: ${task.progressSummary}.` : null,
      ].filter((entry): entry is string => Boolean(entry));
      return parts.join(" ");
    }),
    'Use `action:"status"` for progress; wait for each completion event instead of retrying the same request.',
  ];
  return lines.join("\n");
}

export function buildActiveImageGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    sessionKey,
    taskKind: IMAGE_GENERATION_TASK_KIND,
    sourcePrefix: IMAGE_GENERATION_SOURCE_PREFIX,
    nounLabel: "Image generation",
    toolName: "image_generate",
    completionLabel: "images",
  });
}
