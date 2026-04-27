import type { TaskRecord } from "../tasks/task-registry.types.js";
export declare const MUSIC_GENERATION_TASK_KIND = "music_generation";
export declare function findActiveMusicGenerationTaskForSession(sessionKey?: string): TaskRecord | undefined;
export declare function buildMusicGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown>;
export declare function buildMusicGenerationTaskStatusText(task: TaskRecord, params?: {
    duplicateGuard?: boolean;
}): string;
export declare function buildActiveMusicGenerationTaskPromptContextForSession(sessionKey?: string): string | undefined;
