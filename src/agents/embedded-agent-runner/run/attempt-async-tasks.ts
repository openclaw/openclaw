import { createAbortError as createNamedAbortError } from "../../../infra/abort-signal.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  findMediaGenerationOperation,
  isTerminalMediaGenerationStatus,
  listMediaGenerationOperations,
  onMediaGenerationOperationChanged,
  type MediaGenerationOperation,
} from "../../media-generation-activity.js";

export type AsyncStartedToolMeta = {
  toolName?: string;
  asyncStarted?: boolean;
  asyncTaskRunId?: string;
  asyncTaskId?: string;
};

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

function isPendingCompletionTask(task: MediaGenerationOperation): boolean {
  return (
    COMPLETION_REQUIRED_TASK_KINDS.has(task.taskKind) &&
    task.completionDelivery !== "queued" &&
    !isTerminalMediaGenerationStatus(task.status)
  );
}

function* iterateAsyncTaskRunIds(
  toolMetas: readonly AsyncStartedToolMeta[],
  sessionKey: string | undefined,
): Generator<string> {
  for (const meta of toolMetas) {
    const runId = meta.asyncStarted === true ? meta.asyncTaskRunId?.trim() : undefined;
    if (runId && findMediaGenerationOperation(runId)?.completionDelivery !== "queued") {
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
  onDeadlineChanged: (listener: () => void) => () => void;
  abortSignal?: AbortSignal;
}) {
  const waitedRunIds = new Set<string>();
  const timedOutRunIds = new Set<string>();
  let changed = createDeferredCore();
  const wake = () => changed.resolve();
  const sessionKey = params.sessionKey?.trim();
  const stopMedia = onMediaGenerationOperationChanged((operation) => {
    if (
      operation.requesterSessionKey === sessionKey ||
      (operation.runId && waitedRunIds.has(operation.runId))
    ) {
      wake();
    }
  });
  const stopDeadline = params.onDeadlineChanged(wake);
  params.abortSignal?.addEventListener("abort", wake, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
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
          // Queued delivery needs this same session; waiting would hold its lane.
          if (task?.completionDelivery === "queued") {
            return false;
          }
          return !task || !isTerminalMediaGenerationStatus(task.status);
        });
        if (pendingRunIds.length === 0) {
          break;
        }
        // Approval pauses and resumed grace windows publish a replacement deadline.
        const deadlineAtMs = params.getDeadlineAtMs();
        const remainingMs = deadlineAtMs === undefined ? undefined : deadlineAtMs - Date.now();
        if (remainingMs !== undefined && remainingMs <= 0) {
          for (const runId of pendingRunIds) {
            timedOutRunIds.add(runId);
          }
          break waitForTasks;
        }
        if (remainingMs !== undefined) {
          timer = setTimeout(wake, remainingMs);
        }
        await changed.promise;
        clearTimeout(timer);
        timer = undefined;
        changed = createDeferredCore();
      }
    }
    return { timedOutRunIds: [...timedOutRunIds] };
  } finally {
    clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", wake);
    stopDeadline();
    stopMedia();
  }
}
