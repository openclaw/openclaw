import { stableStringify } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import { listMediaGenerationOperations } from "./media-generation-activity.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { buildSessionAsyncTaskStatusDetails } from "./session-async-task-status.js";

/** Marks media as ready while requester delivery is still being confirmed. */
export const MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS =
  "Generated media; delivering completion";

export function buildMediaGenerationRequestKey(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function mediaGenerationSourceMatches(
  task: MediaGenerationOperation,
  sourcePrefix: string,
): boolean {
  const sourceId = task.sourceId?.trim() ?? "";
  return sourceId === sourcePrefix || sourceId.startsWith(`${sourcePrefix}:`);
}

function resolveMediaGenerationTaskRequesterAgentId(
  task: MediaGenerationOperation,
): string | undefined {
  return (
    normalizeOptionalString(task.requesterAgentId) ??
    parseAgentSessionKey(normalizeOptionalString(task.requesterSessionKey))?.agentId
  );
}

function isTaskStillBlockingDuplicateGuard(task: MediaGenerationOperation): boolean {
  return task.status === "queued" || task.status === "running";
}

function getMediaGenerationTaskProviderId(
  task: MediaGenerationOperation,
  sourcePrefix: string,
): string | undefined {
  if (task.provider) {
    return task.provider;
  }
  const sourceId = task.sourceId?.trim() ?? "";
  if (!sourceId.startsWith(`${sourcePrefix}:`)) {
    return undefined;
  }
  const providerId = sourceId.slice(`${sourcePrefix}:`.length).trim();
  return providerId || undefined;
}

/** Lists active media generation tasks for a session, preferring running tasks. */
async function listActiveMediaGenerationTasksForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  excludeDeliveringCompletion?: boolean;
}): Promise<MediaGenerationOperation[]> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return [];
  }
  return selectActiveMediaGenerationTasks(
    params,
    listMediaGenerationOperations(sessionKey, params.agentId),
  );
}

function selectActiveMediaGenerationTasks(
  params: Parameters<typeof listActiveMediaGenerationTasksForSession>[0],
  tasks: readonly MediaGenerationOperation[],
): MediaGenerationOperation[] {
  const taskLabel = normalizeOptionalString(params.taskLabel);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  const matches = tasks.filter(
    (task) =>
      task.taskKind === params.taskKind &&
      isTaskStillBlockingDuplicateGuard(task) &&
      (!params.agentId || resolveMediaGenerationTaskRequesterAgentId(task) === params.agentId) &&
      (!sourcePrefix || mediaGenerationSourceMatches(task, sourcePrefix)) &&
      (!taskLabel || normalizeOptionalString(task.task) === taskLabel) &&
      (!params.excludeDeliveringCompletion ||
        task.progressSummary !== MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS),
  );
  return [
    ...matches.filter((task) => task.status === "running"),
    ...matches.filter((task) => task.status !== "running"),
  ];
}

/** Finds a task that should block duplicate media generation for a session. */
async function findDuplicateGuardMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  requestKey?: string;
}): Promise<MediaGenerationOperation | undefined> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const tasks = listMediaGenerationOperations(sessionKey, params.agentId);
  const active = selectActiveMediaGenerationTasks(params, tasks)[0];
  if (active || !params.requestKey) {
    return active;
  }
  const recent = tasks.findLast(
    (task) =>
      task.requestKey === params.requestKey &&
      task.taskKind === params.taskKind &&
      mediaGenerationSourceMatches(task, params.sourcePrefix) &&
      (!params.agentId || resolveMediaGenerationTaskRequesterAgentId(task) === params.agentId),
  );
  return recent && recent.status === "succeeded" && recent.terminalOutcome !== "blocked"
    ? recent
    : undefined;
}

/** Builds bounded current-turn facts without instructions or elapsed-time fields. */
export function buildActiveMediaGenerationTaskPromptContext(params: {
  tasks: readonly MediaGenerationOperation[];
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
}): string | undefined {
  const tasks = selectActiveMediaGenerationTasks(
    { ...params, excludeDeliveringCompletion: true },
    params.tasks,
  );
  if (tasks.length === 0) {
    return undefined;
  }
  const boundedLiteral = (value: string, maxChars: number) =>
    truncateUtf16Safe(sanitizeForPromptLiteral(value), maxChars);
  const lines = tasks
    .toSorted((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
    .slice(0, 8)
    .map((task) => {
      const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
      return [
        `- tool=${params.sourcePrefix}`,
        `task=${boundedLiteral(task.taskId, 128)}`,
        `status=${task.status}`,
        ...(provider ? [`provider_json=${JSON.stringify(boundedLiteral(provider, 128))}`] : []),
        ...(task.progressSummary
          ? [`progress_json=${JSON.stringify(boundedLiteral(task.progressSummary, 320))}`]
          : []),
      ].join("; ");
    });
  if (tasks.length > lines.length) {
    lines.push(`- additional_tasks=${tasks.length - lines.length}`);
  }
  return lines.join("\n");
}

export function createMediaGenerationTaskStatusOwner(params: {
  taskKind: string;
  toolName: string;
  nounLabel: string;
  completionLabel: string;
  promptCompletionLabel: string;
}) {
  const taskIdentity = { taskKind: params.taskKind, sourcePrefix: params.toolName };
  function buildTaskStatusDetails(
    this: void,
    task: MediaGenerationOperation,
  ): Record<string, unknown> {
    const provider = getMediaGenerationTaskProviderId(task, params.toolName);
    return {
      ...buildSessionAsyncTaskStatusDetails(task),
      active: isTaskStillBlockingDuplicateGuard(task),
      ...(provider ? { provider } : {}),
      ...(task.model ? { model: task.model } : {}),
    };
  }
  return {
    async findActiveTaskForSession(
      this: void,
      sessionKey?: string,
      request?: { prompt?: string; agentId?: string },
    ): Promise<MediaGenerationOperation | undefined> {
      return (
        await listActiveMediaGenerationTasksForSession({
          ...taskIdentity,
          sessionKey,
          taskLabel: request?.prompt,
          agentId: request?.agentId,
        })
      )[0];
    },
    listActiveTasksForSession(this: void, sessionKey?: string, agentId?: string) {
      return listActiveMediaGenerationTasksForSession({ ...taskIdentity, sessionKey, agentId });
    },
    findDuplicateGuardTaskForSession(
      this: void,
      sessionKey?: string,
      request?: { prompt?: string; requestKey?: string; agentId?: string },
    ) {
      return findDuplicateGuardMediaGenerationTaskForSession({
        ...taskIdentity,
        sessionKey,
        taskLabel: request?.prompt,
        requestKey: request?.requestKey,
        agentId: request?.agentId,
      });
    },
    buildTaskStatusDetails,
    buildTaskStatusListDetails(
      this: void,
      tasks: MediaGenerationOperation[],
    ): Record<string, unknown> {
      return {
        async: true,
        active: true,
        existingTask: true,
        taskCount: tasks.length,
        tasks: tasks.map(buildTaskStatusDetails),
      };
    },
    buildTaskStatusText(
      this: void,
      task: MediaGenerationOperation,
      options?: { duplicateGuard?: boolean },
    ) {
      const provider = getMediaGenerationTaskProviderId(task, params.toolName);
      const active = isTaskStillBlockingDuplicateGuard(task) || task.terminalOutcome === "blocked";
      return [
        active
          ? `${params.nounLabel} task ${task.taskId} is already ${task.status}${provider ? ` with ${provider}` : ""}.`
          : `${params.nounLabel} task ${task.taskId} recently ${task.status}${provider ? ` with ${provider}` : ""}.`,
        task.progressSummary ? `Progress: ${task.progressSummary}.` : null,
        options?.duplicateGuard
          ? active
            ? `Do not call ${params.toolName} again for this request. Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished ${params.completionLabel} here.`
            : `Do not call ${params.toolName} again for the same request; this recent ${params.completionLabel} generation already completed.`
          : `Do not wait, poll, or yield for it: end this turn; the completion arrives as a later turn and sends the finished ${params.completionLabel} here.`,
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildTaskStatusListText(this: void, tasks: MediaGenerationOperation[]) {
      const nounLabel = normalizeLowercaseStringOrEmpty(params.nounLabel);
      return [
        `${tasks.length} active ${nounLabel} tasks are queued or running for this session.`,
        ...tasks.map((task) => {
          const provider = getMediaGenerationTaskProviderId(task, params.toolName);
          const runId = task.runId ? ` (run ${task.runId})` : "";
          const progress = task.progressSummary ? ` Progress: ${task.progressSummary}.` : "";
          return `- Task ${task.taskId}${runId} is ${task.status}${provider ? ` with ${provider}` : ""}.${progress}`;
        }),
        `Do not wait, poll, or yield for them: end this turn; each completion arrives as a later turn and sends the finished ${params.promptCompletionLabel} here.`,
        `Only start a new ${params.toolName} call if the user clearly asks for different/new ${params.promptCompletionLabel}.`,
      ].join("\n");
    },
  };
}
