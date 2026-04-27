import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare function isActiveMediaGenerationTask(params: {
    task: TaskRecord;
    taskKind: string;
}): boolean;
export declare function getMediaGenerationTaskProviderId(task: TaskRecord, sourcePrefix: string): string | undefined;
export declare function findActiveMediaGenerationTaskForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
}): TaskRecord | undefined;
export declare function buildMediaGenerationTaskStatusDetails(params: {
    task: TaskRecord;
    sourcePrefix: string;
}): Record<string, unknown>;
export declare function buildMediaGenerationTaskStatusText(params: {
    task: TaskRecord;
    sourcePrefix: string;
    nounLabel: string;
    toolName: string;
    completionLabel: string;
    duplicateGuard?: boolean;
}): string;
export declare function buildActiveMediaGenerationTaskPromptContextForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    nounLabel: string;
    toolName: string;
    completionLabel: string;
}): string | undefined;
