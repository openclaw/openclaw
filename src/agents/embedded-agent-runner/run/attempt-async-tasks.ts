/**
 * Waits for completion-required async tasks before finalizing an attempt.
 */
import {
  createAbortError as createNamedAbortError,
  racePromiseWithAbortSignal,
} from "../../../infra/abort-signal.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { toErrorObject } from "../../../infra/errors.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { findTaskByRunIdAsync } from "../../../tasks/task-registry-query.js";
import {
  prepareTaskRegistryRead,
  type TaskRegistryRead,
} from "../../../tasks/task-registry-read.js";
import { isTerminalTaskStatus, type TaskRecord } from "../../../tasks/task-registry.types.js";
import { sleep } from "../../../utils/sleep.js";

export type AsyncStartedToolMeta = {
  toolName?: string;
  asyncStarted?: boolean;
  asyncTaskRunId?: string;
  asyncTaskId?: string;
};

/** Summary of completion-required async task waits performed before a cron run can finish. */
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
  return isFastTestRuntimeEnv() ? 10 : DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS;
}

function createAbortError(signal: AbortSignal): Error {
  return createNamedAbortError("aborted", {
    cause: "reason" in signal ? (signal as { reason?: unknown }).reason : undefined,
  });
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
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(err, "Non-Error rejection"));
      },
    );
  });
}

function collectAsyncTaskRunIds(
  toolMetas: readonly AsyncStartedToolMeta[],
  sessionKey: string | undefined,
  alreadyWaited: ReadonlySet<string>,
  read: TaskRegistryRead,
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
  // Registry lookup catches completion-required tasks started before their
  // tool metadata reached the current attempt result.
  for (const task of listCompletionTasks(read, normalizedSessionKey)) {
    if (!COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "")) {
      continue;
    }
    if (isTerminalTaskStatus(task.status)) {
      continue;
    }
    addRunId(task.runId);
  }
  return runIds;
}

function listCompletionTasks(read: TaskRegistryRead, sessionKey: string): TaskRecord[] {
  return read
    .listTasksForRelatedSessionKey(sessionKey)
    .filter((task) => task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey);
}

async function prepareCompletionTaskRead(signal?: AbortSignal): Promise<TaskRegistryRead> {
  throwIfAborted(signal);
  // Abort only this observation; accepted registry mutations retain their settlement owner.
  const read = await racePromiseWithAbortSignal(prepareTaskRegistryRead(), signal);
  throwIfAborted(signal);
  if (!read) {
    throw new Error("Task activity did not stabilize before completion.");
  }
  return read;
}

async function findTerminalTasks(
  runIds: readonly string[],
  read: TaskRegistryRead,
  signal?: AbortSignal,
): Promise<{
  pendingRunIds: string[];
  terminalTasks: TaskRecord[];
}> {
  const pendingRunIds: string[] = [];
  const terminalTasks: TaskRecord[] = [];
  for (const runId of runIds) {
    throwIfAborted(signal);
    const task = await racePromiseWithAbortSignal(findTaskByRunIdAsync(runId, read), signal);
    throwIfAborted(signal);
    if (task && isTerminalTaskStatus(task.status)) {
      terminalTasks.push(task);
      continue;
    }
    pendingRunIds.push(runId);
  }
  read.assertCurrent();
  return { pendingRunIds, terminalTasks };
}

/** Returns whether a cron run has non-terminal generated-media tasks that must settle first. */
export async function requiresCompletionRequiredAsyncTaskWait(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !isCronRunSessionKey(sessionKey)) {
    return false;
  }
  if (
    params.toolMetas.some(
      (meta) => meta.asyncStarted === true && Boolean(meta.asyncTaskRunId?.trim()),
    )
  ) {
    return true;
  }
  const read = await prepareCompletionTaskRead(params.abortSignal);
  return listCompletionTasks(read, sessionKey).some(
    (task) =>
      COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind ?? "") &&
      !isTerminalTaskStatus(task.status) &&
      Boolean(task.runId?.trim()),
  );
}

/** Returns whether the current attempt should synchronously wait for media tasks. */
export async function shouldWaitForCompletionRequiredAsyncTasks(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
  yieldDetected?: boolean;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  if (params.yieldDetected === true) {
    // sessions_yield pauses the turn so the completion event can wake it later;
    // waiting here would reuse the internal abort signal and turn the pause into AbortError.
    return false;
  }
  return requiresCompletionRequiredAsyncTaskWait({
    sessionKey: params.sessionKey,
    toolMetas: params.toolMetas,
    abortSignal: params.abortSignal,
  });
}

/**
 * Polls completion-required async tasks until they reach terminal state, time
 * out at the run deadline, or abort. Newly discovered task run ids are folded
 * into later poll rounds so task metadata and registry state can arrive in any
 * order.
 */
export async function waitForCompletionRequiredAsyncTasks(params: {
  getToolMetas: () => readonly AsyncStartedToolMeta[];
  sessionKey?: string;
  getDeadlineAtMs: () => number | undefined;
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
    let read = await prepareCompletionTaskRead(params.abortSignal);
    throwIfAborted(params.abortSignal);
    // Re-read metadata every outer loop; tool calls may record async run ids
    // after an earlier task wait finished.
    const runIds = collectAsyncTaskRunIds(
      params.getToolMetas(),
      params.sessionKey,
      waitedRunIds,
      read,
    );
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
      const terminalState = await findTerminalTasks(pendingRunIds, read, params.abortSignal);
      throwIfAborted(params.abortSignal);
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
      // Approval pauses and resumed grace windows replace the owner's deadline.
      // Unlimited waits still use finite sleeps and remain abort-responsive.
      const deadlineAtMs = params.getDeadlineAtMs();
      const remainingMs = deadlineAtMs === undefined ? pollIntervalMs : deadlineAtMs - now();
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
      throwIfAborted(params.abortSignal);
      read = await prepareCompletionTaskRead(params.abortSignal);
    }
  }
}
