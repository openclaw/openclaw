import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { isTerminalTaskStatus } from "../../../tasks/task-executor-policy.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import {
  findTaskByRunIdForStatus,
  listTaskRecordsForStatus,
} from "../../../tasks/task-status-access.js";

export type AsyncStartedToolMeta = {
  toolName?: string;
  asyncStarted?: boolean;
  asyncTaskRunId?: string;
  asyncTaskId?: string;
};

export type CompletionRequiredAsyncTaskWaitResult = {
  waitedRunIds: string[];
  timedOutRunIds: string[];
  terminalTasks: TaskRecord[];
};

const DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS = 500;
const COMPLETION_REQUIRED_TASK_KINDS = new Set([
  "image_generation",
  "music_generation",
  "video_generation",
]);

function resolveAsyncTaskPollIntervalMs(): number {
  return process.env.OPENCLAW_TEST_FAST === "1" ? 10 : DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms));
  });
}

function createAbortError(signal: AbortSignal): Error {
  const err = new Error("aborted", {
    cause: "reason" in signal ? (signal as { reason?: unknown }).reason : undefined,
  });
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

async function sleepWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (!signal) {
    await sleepFn(ms);
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleepFn(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function collectAsyncTaskRunIds(
  toolMetas: readonly AsyncStartedToolMeta[],
  sessionKey: string | undefined,
  alreadyWaited: ReadonlySet<string>,
): string[] {
  const runIds: string[] = [];
  const seen = new Set<string>();
  const addRunId = (runIdRaw: string | undefined) => {
    const runId = runIdRaw?.trim();
    if (!runId || alreadyWaited.has(runId) || seen.has(runId)) {
      return;
    }
    seen.add(runId);
    runIds.push(runId);
  };
  for (const meta of toolMetas) {
    addRunId(meta.asyncStarted === true ? meta.asyncTaskRunId : undefined);
  }
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return runIds;
  }
  for (const task of listTaskRecordsForStatus()) {
    if (!COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "")) {
      continue;
    }
    if (
      task.requesterSessionKey !== normalizedSessionKey &&
      task.ownerKey !== normalizedSessionKey
    ) {
      continue;
    }
    if (isTerminalTaskStatus(task.status)) {
      continue;
    }
    addRunId(task.runId);
  }
  return runIds;
}

function findTerminalTasks(runIds: readonly string[]): {
  pendingRunIds: string[];
  terminalTasks: TaskRecord[];
} {
  const pendingRunIds: string[] = [];
  const terminalTasks: TaskRecord[] = [];
  for (const runId of runIds) {
    const task = findTaskByRunIdForStatus(runId);
    if (task && isTerminalTaskStatus(task.status)) {
      terminalTasks.push(task);
      continue;
    }
    pendingRunIds.push(runId);
  }
  return { pendingRunIds, terminalTasks };
}

export function requiresCompletionRequiredAsyncTaskWait(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
}): boolean {
  const sessionKey = params.sessionKey?.trim();
  if (!isCronRunSessionKey(sessionKey)) {
    return false;
  }
  if (
    params.toolMetas.some(
      (meta) => meta.asyncStarted === true && Boolean(meta.asyncTaskRunId?.trim()),
    )
  ) {
    return true;
  }
  return listTaskRecordsForStatus().some(
    (task) =>
      COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "") &&
      !isTerminalTaskStatus(task.status) &&
      (task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey) &&
      Boolean(task.runId?.trim()),
  );
}

export async function waitForCompletionRequiredAsyncTasks(params: {
  getToolMetas: () => readonly AsyncStartedToolMeta[];
  sessionKey?: string;
  deadlineAtMs: number;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<CompletionRequiredAsyncTaskWaitResult> {
  const now = params.now ?? Date.now;
  const sleepFn = params.sleep ?? sleep;
  const pollIntervalMs = params.pollIntervalMs ?? resolveAsyncTaskPollIntervalMs();
  const waitedRunIds = new Set<string>();
  const timedOutRunIds = new Set<string>();
  const terminalTasksByRunId = new Map<string, TaskRecord>();

  while (true) {
    throwIfAborted(params.abortSignal);
    const runIds = collectAsyncTaskRunIds(params.getToolMetas(), params.sessionKey, waitedRunIds);
    if (runIds.length === 0) {
      return {
        waitedRunIds: [...waitedRunIds],
        timedOutRunIds: [...timedOutRunIds],
        terminalTasks: [...terminalTasksByRunId.values()],
      };
    }

    for (const runId of runIds) {
      waitedRunIds.add(runId);
    }

    let pendingRunIds = runIds;
    while (pendingRunIds.length > 0) {
      throwIfAborted(params.abortSignal);
      const terminalState = findTerminalTasks(pendingRunIds);
      for (const task of terminalState.terminalTasks) {
        const runId = task.runId?.trim();
        if (runId) {
          terminalTasksByRunId.set(runId, task);
        }
      }
      pendingRunIds = terminalState.pendingRunIds;
      if (pendingRunIds.length === 0) {
        break;
      }
      const remainingMs = params.deadlineAtMs - now();
      if (remainingMs <= 0) {
        for (const runId of pendingRunIds) {
          timedOutRunIds.add(runId);
        }
        return {
          waitedRunIds: [...waitedRunIds],
          timedOutRunIds: [...timedOutRunIds],
          terminalTasks: [...terminalTasksByRunId.values()],
        };
      }
      await sleepWithAbort(Math.min(pollIntervalMs, remainingMs), params.abortSignal, sleepFn);
    }
  }
}
