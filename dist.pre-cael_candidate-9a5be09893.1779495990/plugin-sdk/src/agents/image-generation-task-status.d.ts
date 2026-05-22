import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare const IMAGE_GENERATION_TASK_KIND = "image_generation";
export declare function isActiveImageGenerationTask(task: TaskRecord): boolean;
export declare function getImageGenerationTaskProviderId(task: TaskRecord): string | undefined;
export declare function findActiveImageGenerationTaskForSession(sessionKey?: string, params?: {
    prompt?: string;
}): TaskRecord | undefined;
export declare function buildImageGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown>;
export declare function buildImageGenerationTaskStatusText(task: TaskRecord, params?: {
    duplicateGuard?: boolean;
}): string;
export declare function buildActiveImageGenerationTaskPromptContextForSession(sessionKey?: string): string | undefined;
