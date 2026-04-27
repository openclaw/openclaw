import { buildActiveMediaGenerationTaskPromptContextForSession, buildMediaGenerationTaskStatusDetails, buildMediaGenerationTaskStatusText, findActiveMediaGenerationTaskForSession, } from "./media-generation-task-status-shared.js";
export const MUSIC_GENERATION_TASK_KIND = "music_generation";
const MUSIC_GENERATION_SOURCE_PREFIX = "music_generate";
export function findActiveMusicGenerationTaskForSession(sessionKey) {
    return findActiveMediaGenerationTaskForSession({
        sessionKey,
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    });
}
export function buildMusicGenerationTaskStatusDetails(task) {
    return buildMediaGenerationTaskStatusDetails({
        task,
        sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    });
}
export function buildMusicGenerationTaskStatusText(task, params) {
    return buildMediaGenerationTaskStatusText({
        task,
        sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
        nounLabel: "Music generation",
        toolName: "music_generate",
        completionLabel: "music",
        duplicateGuard: params?.duplicateGuard,
    });
}
export function buildActiveMusicGenerationTaskPromptContextForSession(sessionKey) {
    return buildActiveMediaGenerationTaskPromptContextForSession({
        sessionKey,
        taskKind: MUSIC_GENERATION_TASK_KIND,
        sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
        nounLabel: "Music generation",
        toolName: "music_generate",
        completionLabel: "music tracks",
    });
}
