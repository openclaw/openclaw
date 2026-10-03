import { stableStringify } from "@openclaw/normalization-core";
/**
 * Shared media generation task status and duplicate-guard helpers.
 *
 * Image/video task modules use this to track recent starts, find active
 * background tasks, and build consistent user/prompt status messages.
 */
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

type RecentMediaGenerationTaskStart = {
  taskId: string;
  runId?: string;
  startedAt: number;
  requestKey?: string;
};

const recentMediaGenerationTaskStarts = new Map<string, RecentMediaGenerationTaskStart[]>();
const RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS = 2 * 60_000;

/** Builds a stable request key for media generation duplicate detection. */
export function buildMediaGenerationRequestKey(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function buildRecentMediaGenerationTaskKey(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const taskKind = normalizeOptionalString(params.taskKind);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  if (!sessionKey || !taskKind || !sourcePrefix) {
    return undefined;
  }
  return `${params.agentId?.trim() ?? "unknown"}\0${sessionKey}\0${taskKind}\0${sourcePrefix}`;
}

function isRecentMediaGenerationActivity(activityAt: number, nowMs: number): boolean {
  return (
    Number.isFinite(activityAt) && nowMs - activityAt <= RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS
  );
}

function pruneRecentMediaGenerationTaskStarts(params: { nowMs: number; preserveKey?: string }) {
  for (const [key, entries] of recentMediaGenerationTaskStarts.entries()) {
    if (params.preserveKey === key) {
      continue;
    }
    const freshEntries = entries.filter((entry) =>
      isRecentMediaGenerationActivity(entry.startedAt, params.nowMs),
    );
    if (freshEntries.length > 0) {
      recentMediaGenerationTaskStarts.set(key, freshEntries);
    } else {
      recentMediaGenerationTaskStarts.delete(key);
    }
  }
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
  const explicit = normalizeOptionalString(task.requesterAgentId);
  if (explicit) {
    return explicit;
  }
  return parseAgentSessionKey(normalizeOptionalString(task.requesterSessionKey))?.agentId;
}

function isTaskStillBlockingDuplicateGuard(task: MediaGenerationOperation): boolean {
  return task.status === "queued" || task.status === "running";
}

function recentMediaGenerationTaskStartMatches(
  left: RecentMediaGenerationTaskStart,
  right: RecentMediaGenerationTaskStart,
): boolean {
  if (left.requestKey && right.requestKey) {
    return left.requestKey === right.requestKey;
  }
  if (left.runId && right.runId) {
    return left.runId === right.runId;
  }
  return left.taskId === right.taskId;
}

/** Correlates a request with its already-admitted native media operation. */
export function recordRecentMediaGenerationTaskStartForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskId: string;
  runId?: string;
  taskLabel: string;
  requestKey?: string;
  providerId?: string;
  progressSummary: string;
  nowMs?: number;
}) {
  const key = buildRecentMediaGenerationTaskKey(params);
  if (!key) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneRecentMediaGenerationTaskStarts({
    nowMs,
    preserveKey: key,
  });
  const entry: RecentMediaGenerationTaskStart = {
    requestKey: normalizeOptionalString(params.requestKey),
    taskId: params.taskId,
    runId: params.runId,
    startedAt: nowMs,
  };
  const previousEntries = (recentMediaGenerationTaskStarts.get(key) ?? []).filter((entryLocal) =>
    isRecentMediaGenerationActivity(entryLocal.startedAt, nowMs),
  );
  recentMediaGenerationTaskStarts.set(key, [
    ...previousEntries.filter(
      (previousEntry) => !recentMediaGenerationTaskStartMatches(previousEntry, entry),
    ),
    entry,
  ]);
}

/** Finds a recent matching request only while its native operation is retained. */
function findRecentStartedMediaGenerationTaskForSession(params: {
  tasks: readonly MediaGenerationOperation[];
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  requestKey?: string;
}): MediaGenerationOperation | undefined {
  const key = buildRecentMediaGenerationTaskKey(params);
  if (!key) {
    return undefined;
  }
  const nowMs = Date.now();
  const taskLabel = normalizeOptionalString(params.taskLabel);
  // The operation owner is registered before request metadata; a cache entry
  // cannot restore work that owner has retired.
  pruneRecentMediaGenerationTaskStarts({ nowMs, preserveKey: key });
  const entries = recentMediaGenerationTaskStarts.get(key);
  if (!entries?.length) {
    return undefined;
  }
  const retainedEntries: RecentMediaGenerationTaskStart[] = [];
  for (const entry of entries.toReversed()) {
    const persistedTask = params.tasks.find(
      (task) =>
        task.taskKind === params.taskKind &&
        mediaGenerationSourceMatches(task, params.sourcePrefix) &&
        (!params.agentId || resolveMediaGenerationTaskRequesterAgentId(task) === params.agentId) &&
        (task.taskId === entry.taskId || Boolean(task.runId && task.runId === entry.runId)),
    );
    if (persistedTask) {
      const persistedTaskLabelMatches =
        !taskLabel || normalizeOptionalString(persistedTask.task) === taskLabel;
      if (isTaskStillBlockingDuplicateGuard(persistedTask) && persistedTaskLabelMatches) {
        return persistedTask;
      }
      const recent = isRecentMediaGenerationActivity(
        persistedTask.endedAt ??
          persistedTask.lastEventAt ??
          persistedTask.startedAt ??
          persistedTask.createdAt,
        nowMs,
      );
      if (
        recent &&
        persistedTask.status === "succeeded" &&
        persistedTask.terminalOutcome !== "blocked" &&
        params.requestKey &&
        entry.requestKey === params.requestKey
      ) {
        return persistedTask;
      }
      if (recent) {
        retainedEntries.push(entry);
      }
    }
  }
  if (retainedEntries.length > 0) {
    recentMediaGenerationTaskStarts.set(key, retainedEntries.toReversed());
  } else {
    recentMediaGenerationTaskStarts.delete(key);
  }
  return undefined;
}

/** Clears in-memory duplicate guards between tests. */
function resetRecentMediaGenerationDuplicateGuardsForTests() {
  recentMediaGenerationTaskStarts.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaGenerationDuplicateGuardTestApi")
  ] = { resetRecentMediaGenerationDuplicateGuardsForTests };
}

/** Extracts a provider id from a media task source id with the given prefix. */
function getMediaGenerationTaskProviderId(
  task: MediaGenerationOperation,
  sourcePrefix: string,
): string | undefined {
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
  const matches = tasks.filter((task) => {
    if (task.taskKind !== params.taskKind || !isTaskStillBlockingDuplicateGuard(task)) {
      return false;
    }
    if (params.agentId && resolveMediaGenerationTaskRequesterAgentId(task) !== params.agentId) {
      return false;
    }
    if (sourcePrefix && !mediaGenerationSourceMatches(task, sourcePrefix)) {
      return false;
    }
    if (taskLabel && normalizeOptionalString(task.task) !== taskLabel) {
      return false;
    }
    if (
      params.excludeDeliveringCompletion &&
      task.progressSummary === MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS
    ) {
      return false;
    }
    return true;
  });
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
  return (
    findRecentStartedMediaGenerationTaskForSession({ ...params, sessionKey, tasks }) ??
    selectActiveMediaGenerationTasks(params, tasks)[0]
  );
}

/** Builds structured status details for one media generation task. */
function buildMediaGenerationTaskStatusDetails(params: {
  task: MediaGenerationOperation;
  sourcePrefix: string;
}): Record<string, unknown> {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  return {
    ...buildSessionAsyncTaskStatusDetails(params.task),
    active: isTaskStillBlockingDuplicateGuard(params.task),
    ...(provider ? { provider } : {}),
  };
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

/** Specializes shared task lookup, duplicate guards, and status text for one media tool. */
export function createMediaGenerationTaskStatusOwner(params: {
  taskKind: string;
  toolName: string;
  nounLabel: string;
  completionLabel: string;
  promptCompletionLabel: string;
}) {
  const taskIdentity = { taskKind: params.taskKind, sourcePrefix: params.toolName };
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
    buildTaskStatusDetails(this: void, task: MediaGenerationOperation) {
      return buildMediaGenerationTaskStatusDetails({ task, sourcePrefix: params.toolName });
    },
    buildTaskStatusListDetails(
      this: void,
      tasks: MediaGenerationOperation[],
    ): Record<string, unknown> {
      return {
        async: true,
        active: true,
        existingTask: true,
        taskCount: tasks.length,
        tasks: tasks.map((task) =>
          buildMediaGenerationTaskStatusDetails({ task, sourcePrefix: params.toolName }),
        ),
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
