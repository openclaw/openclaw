import { createAbortError as createNamedAbortError } from "../../../infra/abort-signal.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { toErrorObject } from "../../../infra/errors.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { sleep } from "../../../utils/sleep.js";
import {
  findMediaGenerationOperation,
  isTerminalMediaGenerationStatus,
  listMediaGenerationOperations,
  type MediaGenerationOperation,
} from "../../media-generation-activity.js";

export type AsyncStartedToolMeta = {
  toolName?: string;
  asyncStarted?: boolean;
  asyncTaskRunId?: string;
  asyncTaskId?: string;
};

export type CompletionRequiredAsyncTaskWaitResult = {
  waitedRunIds: string[];
  timedOutRunIds: string[];
  terminalTasks: MediaGenerationOperation[];
};

const DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS = 500;
const COMPLETION_REQUIRED_TASK_KINDS = new Set([
  "image_generation",
  "music_generation",
  "video_generation",
]);

function createAbortError(signal: AbortSignal): Error {
  return createNamedAbortError("aborted", {
    cause: signal.reason,
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

function isPendingCompletionTask(task: MediaGenerationOperation): boolean {
  return (
    COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind) &&
    !isTerminalMediaGenerationStatus(task.status)
  );
}

function* iterateAsyncTaskRunIds(
  toolMetas: readonly AsyncStartedToolMeta[],
  sessionKey: string | undefined,
): Generator<string> {
  for (const meta of toolMetas) {
    const runId = meta.asyncStarted === true ? meta.asyncTaskRunId?.trim() : undefined;
    if (runId) {
      yield runId;
    }
  }
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  // Registry lookup catches completion-required tasks started before their
  // tool metadata reached the current attempt result.
  for (const task of listMediaGenerationOperations(normalizedSessionKey)) {
    if (isPendingCompletionTask(task)) {
      const runId = task.runId?.trim();
      if (runId) {
        yield runId;
      }
    }
  }
}

export function requiresCompletionRequiredAsyncTaskWait(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
  abortSignal?: AbortSignal;
}): boolean {
  throwIfAborted(params.abortSignal);
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !isCronRunSessionKey(sessionKey)) {
    return false;
  }
  return iterateAsyncTaskRunIds(params.toolMetas, sessionKey).next().done === false;
}

export function shouldWaitForCompletionRequiredAsyncTasks(params: {
  sessionKey: string | undefined;
  toolMetas: readonly AsyncStartedToolMeta[];
  yieldDetected?: boolean;
  abortSignal?: AbortSignal;
}): boolean {
  if (params.yieldDetected === true) {
    // sessions_yield pauses the turn so the completion event can wake it later;
    // waiting here would reuse the internal abort signal and turn the pause into AbortError.
    return false;
  }
  return requiresCompletionRequiredAsyncTaskWait(params);
}

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
  const pollIntervalMs =
    params.pollIntervalMs ?? (isFastTestRuntimeEnv() ? 10 : DEFAULT_ASYNC_TASK_POLL_INTERVAL_MS);
  const waitedRunIds = new Set<string>();
  const timedOutRunIds = new Set<string>();
  const terminalTasksByRunId = new Map<string, MediaGenerationOperation>();

  waitForTasks: while (true) {
    throwIfAborted(params.abortSignal);
    // Re-read metadata every outer loop; tool calls may record async run ids
    // after an earlier task wait finished.
    const runIds = [
      ...new Set(iterateAsyncTaskRunIds(params.getToolMetas(), params.sessionKey)),
    ].filter((runId) => !waitedRunIds.has(runId));
    if (runIds.length === 0) {
      break;
    }

    for (const runId of runIds) {
      waitedRunIds.add(runId);
    }

    let pendingRunIds = runIds;
    while (pendingRunIds.length > 0) {
      throwIfAborted(params.abortSignal);
      pendingRunIds = pendingRunIds.filter((runId) => {
        const task = findMediaGenerationOperation(runId);
        if (!task || !isTerminalMediaGenerationStatus(task.status)) {
          return true;
        }
        const taskRunId = task.runId?.trim();
        if (taskRunId) {
          terminalTasksByRunId.set(taskRunId, task);
        }
        return false;
      });
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
        break waitForTasks;
      }
      await sleepWithAbort(Math.min(pollIntervalMs, remainingMs), params.abortSignal, sleepFn);
    }
  }
  return {
    waitedRunIds: [...waitedRunIds],
    timedOutRunIds: [...timedOutRunIds],
    terminalTasks: [...terminalTasksByRunId.values()],
  };
}
