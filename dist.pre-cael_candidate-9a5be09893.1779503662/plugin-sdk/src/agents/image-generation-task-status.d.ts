import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare const IMAGE_GENERATION_TASK_KIND = "image_generation";
export declare function isActiveImageGenerationTask(task: TaskRecord): boolean;
export declare function getImageGenerationTaskProviderId(task: TaskRecord): string | undefined;
export declare function findActiveImageGenerationTaskForSession(sessionKey?: string, params?: {
    prompt?: string;
}): TaskRecord | undefined;
export declare function listActiveImageGenerationTasksForSession(sessionKey?: string): TaskRecord[];
export declare function findDuplicateGuardImageGenerationTaskForSession(sessionKey?: string, params?: {
    prompt?: string;
    requestKey?: string;
}): TaskRecord | undefined;
export declare function buildImageGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown>;
export declare function buildImageGenerationTaskStatusListDetails(tasks: TaskRecord[]): Record<string, unknown>;
export declare function buildImageGenerationTaskStatusText(task: TaskRecord, params?: {
    duplicateGuard?: boolean;
}): string;
export declare function buildImageGenerationTaskStatusListText(tasks: TaskRecord[]): string;
export declare function buildActiveImageGenerationTaskPromptContextForSession(sessionKey?: string): string | undefined;
