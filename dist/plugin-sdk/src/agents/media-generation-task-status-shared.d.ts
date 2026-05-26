import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare function buildMediaGenerationRequestKey(value: Record<string, unknown>): string;
export declare function isActiveMediaGenerationTask(params: {
    task: TaskRecord;
    taskKind: string;
}): boolean;
export declare function recordRecentMediaGenerationTaskStartForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    taskId: string;
    runId?: string;
    taskLabel: string;
    requestKey?: string;
    providerId?: string;
    progressSummary: string;
    nowMs?: number;
}): void;
export declare function findRecentStartedMediaGenerationTaskForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    taskLabel?: string;
    maxAgeMs: number;
    requestKey?: string;
    nowMs?: number;
}): TaskRecord | undefined;
export declare function resetRecentMediaGenerationDuplicateGuardsForTests(): void;
export declare function getMediaGenerationTaskProviderId(task: TaskRecord, sourcePrefix: string): string | undefined;
export declare function findActiveMediaGenerationTaskForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    taskLabel?: string;
}): TaskRecord | undefined;
export declare function listActiveMediaGenerationTasksForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    taskLabel?: string;
}): TaskRecord[];
export declare function findDuplicateGuardMediaGenerationTaskForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    taskLabel?: string;
    requestKey?: string;
    maxAgeMs: number;
}): TaskRecord | undefined;
export declare function buildMediaGenerationTaskStatusDetails(params: {
    task: TaskRecord;
    sourcePrefix: string;
}): Record<string, unknown>;
export declare function buildMediaGenerationTaskStatusListDetails(params: {
    tasks: TaskRecord[];
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
export declare function buildMediaGenerationTaskStatusListText(params: {
    tasks: TaskRecord[];
    sourcePrefix: string;
    nounLabel: string;
    toolName: string;
    completionLabel: string;
}): string;
export declare function buildActiveMediaGenerationTaskPromptContextForSession(params: {
    sessionKey?: string;
    taskKind: string;
    sourcePrefix: string;
    nounLabel: string;
    toolName: string;
    completionLabel: string;
}): string | undefined;
