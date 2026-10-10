import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listMediaGenerationOperations } from "./media-generation-activity.js";
import {
  buildActiveMediaGenerationTaskPromptContext,
  createMediaGenerationTaskStatusOwner,
} from "./media-generation-task-status-shared.js";

export const IMAGE_GENERATION_TASK_KIND = "image_generation";

/** Image generation keeps multi-task status and prompt-specific duplicate lookup. */
export const {
  listActiveTasksForSession: listActiveImageGenerationTasksForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardImageGenerationTaskForSession,
  buildTaskStatusDetails: buildImageGenerationTaskStatusDetails,
  buildTaskStatusListDetails: buildImageGenerationTaskStatusListDetails,
  buildTaskStatusText: buildImageGenerationTaskStatusText,
  buildTaskStatusListText: buildImageGenerationTaskStatusListText,
} = createMediaGenerationTaskStatusOwner({
  taskKind: IMAGE_GENERATION_TASK_KIND,
  toolName: "image_generate",
  nounLabel: "Image generation",
  completionLabel: "image",
  promptCompletionLabel: "images",
});

export const MUSIC_GENERATION_TASK_KIND = "music_generation";

export const {
  findActiveTaskForSession: findActiveMusicGenerationTaskForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardMusicGenerationTaskForSession,
  buildTaskStatusDetails: buildMusicGenerationTaskStatusDetails,
  buildTaskStatusText: buildMusicGenerationTaskStatusText,
} = createMediaGenerationTaskStatusOwner({
  taskKind: MUSIC_GENERATION_TASK_KIND,
  toolName: "music_generate",
  nounLabel: "Music generation",
  completionLabel: "music",
  promptCompletionLabel: "music tracks",
});

export const VIDEO_GENERATION_TASK_KIND = "video_generation";

export const {
  findActiveTaskForSession: findActiveVideoGenerationTaskForSession,
  findDuplicateGuardTaskForSession: findDuplicateGuardVideoGenerationTaskForSession,
  buildTaskStatusDetails: buildVideoGenerationTaskStatusDetails,
  buildTaskStatusText: buildVideoGenerationTaskStatusText,
} = createMediaGenerationTaskStatusOwner({
  taskKind: VIDEO_GENERATION_TASK_KIND,
  toolName: "video_generate",
  nounLabel: "Video generation",
  completionLabel: "video",
  promptCompletionLabel: "videos",
});

/** Shared by embedded and CLI prompts; all sections use this turn's owner snapshot. */
export async function buildMediaTaskRuntimeContext(params: {
  capabilityToolNames: ReadonlySet<string>;
  sessionKey?: string;
  agentId: string;
  /** Retained carriers need explicit empty snapshots to supersede older facts. */
  includeEmptySnapshots?: boolean;
}): Promise<string | undefined> {
  const sections = [
    ["image_generate", IMAGE_GENERATION_TASK_KIND],
    ["music_generate", MUSIC_GENERATION_TASK_KIND],
    ["video_generate", VIDEO_GENERATION_TASK_KIND],
  ] as const;
  const enabled = sections.filter(([tool]) => params.capabilityToolNames.has(tool));
  if (enabled.length === 0) {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const tasks = sessionKey ? listMediaGenerationOperations(sessionKey, params.agentId) : [];
  const facts = enabled.flatMap(([tool, taskKind]) => {
    const text = buildActiveMediaGenerationTaskPromptContext({
      tasks,
      agentId: params.agentId,
      taskKind,
      sourcePrefix: tool,
    });
    return text ? [text] : params.includeEmptySnapshots ? [`- tool=${tool}; none`] : [];
  });
  return facts.length ? ["## Media Generation Tasks", ...facts].join("\n") : undefined;
}
