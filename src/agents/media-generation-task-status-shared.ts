import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { listFreshTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { buildSessionAsyncTaskStatusDetails } from "./session-async-task-status.js";
import { stableStringify } from "./stable-stringify.js";

type RecentMediaGenerationTaskStart = {
  task: TaskRecord;
  requestKey?: string;
};

const recentMediaGenerationTaskStarts = new Map<string, RecentMediaGenerationTaskStart>();

export function buildMediaGenerationRequestKey(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function buildRecentMediaGenerationTaskKey(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const taskKind = normalizeOptionalString(params.taskKind);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  if (!sessionKey || !taskKind || !sourcePrefix) {
    return undefined;
  }
  return `${sessionKey}\0${taskKind}\0${sourcePrefix}`;
}

function isRecentMediaGenerationTaskRecord(params: {
  task: TaskRecord;
  maxAgeMs: number;
  nowMs: number;
}) {
  const activityAt =
    params.task.endedAt ??
    params.task.lastEventAt ??
    params.task.startedAt ??
    params.task.createdAt;
  return Number.isFinite(activityAt) && params.nowMs - activityAt <= params.maxAgeMs;
}

function pruneRecentMediaGenerationTaskStarts(params: {
  maxAgeMs: number;
  nowMs: number;
  preserveKey?: string;
}) {
  for (const [key, entry] of recentMediaGenerationTaskStarts.entries()) {
    if (params.preserveKey === key) {
      continue;
    }
    if (!isRecentMediaGenerationTaskRecord({ task: entry.task, ...params })) {
      recentMediaGenerationTaskStarts.delete(key);
    }
  }
}

function mediaGenerationSourceMatches(task: TaskRecord, sourcePrefix: string): boolean {
  const sourceId = task.sourceId?.trim() ?? "";
  return sourceId === sourcePrefix || sourceId.startsWith(`${sourcePrefix}:`);
}

function mediaGenerationTaskLabelMatches(task: TaskRecord, taskLabel: string): boolean {
  return normalizeOptionalString(task.task) === taskLabel;
}

function isTaskStillBlockingDuplicateGuard(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTaskRecentSuccessfulDuplicate(params: {
  task: TaskRecord;
  requestKey?: string;
  cachedRequestKey?: string;
  maxAgeMs: number;
  nowMs: number;
}): boolean {
  return (
    params.task.status === "succeeded" &&
    Boolean(params.requestKey && params.cachedRequestKey === params.requestKey) &&
    isRecentMediaGenerationTaskRecord({
      task: params.task,
      maxAgeMs: params.maxAgeMs,
      nowMs: params.nowMs,
    })
  );
}

function findPersistedTaskForRecentMediaGenerationStart(params: {
  sessionKey: string;
  cachedTask: TaskRecord;
  taskKind: string;
  sourcePrefix: string;
}): TaskRecord | undefined {
  return listFreshTasksForOwnerKey(params.sessionKey).find((task) => {
    if (
      task.runtime !== "cli" ||
      task.scopeKind !== "session" ||
      task.taskKind !== params.taskKind ||
      !mediaGenerationSourceMatches(task, params.sourcePrefix)
    ) {
      return false;
    }
    if (task.taskId === params.cachedTask.taskId) {
      return true;
    }
    return Boolean(task.runId && task.runId === params.cachedTask.runId);
  });
}

export function isActiveMediaGenerationTask(params: {
  task: TaskRecord;
  taskKind: string;
}): boolean {
  return (
    params.task.runtime === "cli" &&
    params.task.scopeKind === "session" &&
    params.task.taskKind === params.taskKind &&
    (params.task.status === "queued" || params.task.status === "running")
  );
}

export function recordRecentMediaGenerationTaskStartForSession(params: {
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
}) {
  const key = buildRecentMediaGenerationTaskKey(params);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!key || !sessionKey) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  recentMediaGenerationTaskStarts.set(key, {
    requestKey: normalizeOptionalString(params.requestKey),
    task: {
      taskId: params.taskId,
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId?.trim()
        ? `${params.sourcePrefix}:${params.providerId.trim()}`
        : params.sourcePrefix,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      ...(params.runId ? { runId: params.runId } : {}),
      task: params.taskLabel,
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: nowMs,
      startedAt: nowMs,
      lastEventAt: nowMs,
      progressSummary: params.progressSummary,
    },
  });
}

export function findRecentStartedMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  maxAgeMs: number;
  requestKey?: string;
  nowMs?: number;
}): TaskRecord | undefined {
  const key = buildRecentMediaGenerationTaskKey(params);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!key || !sessionKey) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const maxAgeMs = Math.max(0, Math.floor(params.maxAgeMs));
  pruneRecentMediaGenerationTaskStarts({ maxAgeMs, nowMs, preserveKey: key });
  const entry = recentMediaGenerationTaskStarts.get(key);
  const task = entry?.task;
  if (!entry || !task) {
    return undefined;
  }
  const persistedTask = findPersistedTaskForRecentMediaGenerationStart({
    sessionKey,
    cachedTask: task,
    taskKind: params.taskKind,
    sourcePrefix: params.sourcePrefix,
  });
  if (persistedTask) {
    if (isTaskStillBlockingDuplicateGuard(persistedTask)) {
      return persistedTask;
    }
    if (persistedTask.status === "succeeded" && entry.requestKey && !params.requestKey) {
      return undefined;
    }
    if (
      isTaskRecentSuccessfulDuplicate({
        task: persistedTask,
        requestKey: params.requestKey,
        cachedRequestKey: entry.requestKey,
        maxAgeMs,
        nowMs,
      })
    ) {
      return persistedTask;
    }
    recentMediaGenerationTaskStarts.delete(key);
    return undefined;
  }
  if (!isRecentMediaGenerationTaskRecord({ task, maxAgeMs, nowMs })) {
    recentMediaGenerationTaskStarts.delete(key);
    return undefined;
  }
  return { ...task };
}

export function resetRecentMediaGenerationDuplicateGuardsForTests() {
  recentMediaGenerationTaskStarts.clear();
}

export function getMediaGenerationTaskProviderId(
  task: TaskRecord,
  sourcePrefix: string,
): string | undefined {
  const sourceId = task.sourceId?.trim() ?? "";
  if (!sourceId.startsWith(`${sourcePrefix}:`)) {
    return undefined;
  }
  const providerId = sourceId.slice(`${sourcePrefix}:`.length).trim();
  return providerId || undefined;
}

export function findActiveMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
}): TaskRecord | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const taskLabel = normalizeOptionalString(params.taskLabel);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  const matches = listFreshTasksForOwnerKey(sessionKey).filter((task) => {
    if (
      task.runtime !== "cli" ||
      task.scopeKind !== "session" ||
      task.taskKind !== params.taskKind ||
      !isTaskStillBlockingDuplicateGuard(task)
    ) {
      return false;
    }
    if (sourcePrefix && !mediaGenerationSourceMatches(task, sourcePrefix)) {
      return false;
    }
    if (taskLabel && !mediaGenerationTaskLabelMatches(task, taskLabel)) {
      return false;
    }
    return true;
  });
  return matches.find((task) => task.status === "running") ?? matches[0];
}

export function findDuplicateGuardMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  requestKey?: string;
  maxAgeMs: number;
}): TaskRecord | undefined {
  return (
    findRecentStartedMediaGenerationTaskForSession(params) ??
    findActiveMediaGenerationTaskForSession({
      sessionKey: params.sessionKey,
      taskKind: params.taskKind,
      sourcePrefix: params.sourcePrefix,
    }) ??
    undefined
  );
}

export function buildMediaGenerationTaskStatusDetails(params: {
  task: TaskRecord;
  sourcePrefix: string;
}): Record<string, unknown> {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  return {
    ...buildSessionAsyncTaskStatusDetails(params.task),
    active: isTaskStillBlockingDuplicateGuard(params.task),
    ...(provider ? { provider } : {}),
  };
}

export function buildMediaGenerationTaskStatusText(params: {
  task: TaskRecord;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
  duplicateGuard?: boolean;
}): string {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  const active =
    params.task.status === "queued" ||
    params.task.status === "running" ||
    params.task.terminalOutcome === "blocked";
  const lines = [
    active
      ? `${params.nounLabel} task ${params.task.taskId} is already ${params.task.status}${provider ? ` with ${provider}` : ""}.`
      : `${params.nounLabel} task ${params.task.taskId} recently ${params.task.status}${provider ? ` with ${provider}` : ""}.`,
    params.task.progressSummary ? `Progress: ${params.task.progressSummary}.` : null,
    params.duplicateGuard
      ? `Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here.`
      : `Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}

export function buildActiveMediaGenerationTaskPromptContextForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
}): string | undefined {
  const task = findActiveMediaGenerationTaskForSession({
    sessionKey: params.sessionKey,
    taskKind: params.taskKind,
    sourcePrefix: params.sourcePrefix,
  });
  if (!task) {
    return undefined;
  }
  const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
  const lines = [
    `An active ${normalizeLowercaseStringOrEmpty(params.nounLabel)} background task already exists for this session.`,
    `Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
    task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
    `Do not call \`${params.toolName}\` again for the same request while that task is queued or running.`,
    `If the user asks for progress or whether the work is async, explain the active task state or call \`${params.toolName}\` with \`action:"status"\` instead of starting a new generation.`,
    `Only start a new \`${params.toolName}\` call if the user clearly asks for different/new ${params.completionLabel}.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}
