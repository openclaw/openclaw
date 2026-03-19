type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
  /**
   * Optional hint for retry gaps where waitForIdle() can transiently resolve
   * before a scheduled auto-retry starts a new running prompt.
   * When true, the flush loop re-waits instead of flushing immediately.
   */
  hasPendingToolCalls?: (() => boolean) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return false;
  }

  const idleResolved = Symbol("idle");
  const idleTimedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForIdle.call(agent).then(() => idleResolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return outcome === idleTimedOut;
  } catch {
    // Best-effort during cleanup.
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS;
  const waitStartedAt = Date.now();

  while (true) {
    const timedOut = await waitForAgentIdleBestEffort(opts.agent, timeoutMs);

    if (timedOut) {
      if (opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
        opts.sessionManager.clearPendingToolResults();
        return;
      }
      opts.sessionManager?.flushPendingToolResults?.();
      return;
    }

    // Guard against overloaded-retry gaps: waitForIdle can briefly resolve
    // while a scheduled retry has not yet started. If tool calls are still
    // pending, give the agent another tick to start and wait again.
    const hasPendingToolCalls = opts.agent?.hasPendingToolCalls;
    if (typeof hasPendingToolCalls === "function" && hasPendingToolCalls.call(opts.agent)) {
      if (Date.now() - waitStartedAt >= timeoutMs) {
        if (opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
          opts.sessionManager.clearPendingToolResults();
          return;
        }
        opts.sessionManager?.flushPendingToolResults?.();
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }

    opts.sessionManager?.flushPendingToolResults?.();
    return;
  }
}
