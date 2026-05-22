import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { n as findActiveSessionTask, t as buildSessionAsyncTaskStatusDetails } from "./session-async-task-status-CwddFmIb.js";
//#region src/agents/media-generation-task-status-shared.ts
function getMediaGenerationTaskProviderId(task, sourcePrefix) {
	const sourceId = task.sourceId?.trim() ?? "";
	if (!sourceId.startsWith(`${sourcePrefix}:`)) return;
	return sourceId.slice(`${sourcePrefix}:`.length).trim() || void 0;
}
function findActiveMediaGenerationTaskForSession(params) {
	return findActiveSessionTask({
		sessionKey: params.sessionKey,
		runtime: "cli",
		taskKind: params.taskKind,
		sourceIdPrefix: params.sourcePrefix
	});
}
function buildMediaGenerationTaskStatusDetails(params) {
	const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
	return {
		...buildSessionAsyncTaskStatusDetails(params.task),
		...provider ? { provider } : {}
	};
}
function buildMediaGenerationTaskStatusText(params) {
	const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
	return [
		`${params.nounLabel} task ${params.task.taskId} is already ${params.task.status}${provider ? ` with ${provider}` : ""}.`,
		params.task.progressSummary ? `Progress: ${params.task.progressSummary}.` : null,
		params.duplicateGuard ? `Do not call ${params.toolName} again for this request. Wait for the completion event; I will post the finished ${params.completionLabel} here.` : `Wait for the completion event; I will post the finished ${params.completionLabel} here when it's ready.`
	].filter((entry) => Boolean(entry)).join("\n");
}
function buildActiveMediaGenerationTaskPromptContextForSession(params) {
	const task = findActiveMediaGenerationTaskForSession({
		sessionKey: params.sessionKey,
		taskKind: params.taskKind,
		sourcePrefix: params.sourcePrefix
	});
	if (!task) return;
	const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
	return [
		`An active ${normalizeLowercaseStringOrEmpty(params.nounLabel)} background task already exists for this session.`,
		`Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
		task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
		`Do not call \`${params.toolName}\` again for the same request while that task is queued or running.`,
		`If the user asks for progress or whether the work is async, explain the active task state or call \`${params.toolName}\` with \`action:"status"\` instead of starting a new generation.`,
		`Only start a new \`${params.toolName}\` call if the user clearly asks for different/new ${params.completionLabel}.`
	].filter((entry) => Boolean(entry)).join("\n");
}
//#endregion
//#region src/agents/music-generation-task-status.ts
const MUSIC_GENERATION_TASK_KIND = "music_generation";
const MUSIC_GENERATION_SOURCE_PREFIX = "music_generate";
function findActiveMusicGenerationTaskForSession(sessionKey) {
	return findActiveMediaGenerationTaskForSession({
		sessionKey,
		taskKind: MUSIC_GENERATION_TASK_KIND,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX
	});
}
function buildMusicGenerationTaskStatusDetails(task) {
	return buildMediaGenerationTaskStatusDetails({
		task,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX
	});
}
function buildMusicGenerationTaskStatusText(task, params) {
	return buildMediaGenerationTaskStatusText({
		task,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
		nounLabel: "Music generation",
		toolName: "music_generate",
		completionLabel: "music",
		duplicateGuard: params?.duplicateGuard
	});
}
function buildActiveMusicGenerationTaskPromptContextForSession(sessionKey) {
	return buildActiveMediaGenerationTaskPromptContextForSession({
		sessionKey,
		taskKind: MUSIC_GENERATION_TASK_KIND,
		sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
		nounLabel: "Music generation",
		toolName: "music_generate",
		completionLabel: "music tracks"
	});
}
//#endregion
//#region src/agents/video-generation-task-status.ts
const VIDEO_GENERATION_TASK_KIND = "video_generation";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";
function findActiveVideoGenerationTaskForSession(sessionKey) {
	return findActiveMediaGenerationTaskForSession({
		sessionKey,
		taskKind: VIDEO_GENERATION_TASK_KIND,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX
	});
}
function buildVideoGenerationTaskStatusDetails(task) {
	return buildMediaGenerationTaskStatusDetails({
		task,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX
	});
}
function buildVideoGenerationTaskStatusText(task, params) {
	return buildMediaGenerationTaskStatusText({
		task,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
		nounLabel: "Video generation",
		toolName: "video_generate",
		completionLabel: "video",
		duplicateGuard: params?.duplicateGuard
	});
}
function buildActiveVideoGenerationTaskPromptContextForSession(sessionKey) {
	return buildActiveMediaGenerationTaskPromptContextForSession({
		sessionKey,
		taskKind: VIDEO_GENERATION_TASK_KIND,
		sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
		nounLabel: "Video generation",
		toolName: "video_generate",
		completionLabel: "videos"
	});
}
//#endregion
export { findActiveVideoGenerationTaskForSession as a, buildMusicGenerationTaskStatusDetails as c, buildVideoGenerationTaskStatusText as i, buildMusicGenerationTaskStatusText as l, buildActiveVideoGenerationTaskPromptContextForSession as n, MUSIC_GENERATION_TASK_KIND as o, buildVideoGenerationTaskStatusDetails as r, buildActiveMusicGenerationTaskPromptContextForSession as s, VIDEO_GENERATION_TASK_KIND as t, findActiveMusicGenerationTaskForSession as u };
