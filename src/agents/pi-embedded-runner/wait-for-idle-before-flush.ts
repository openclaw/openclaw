type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

type FlushPendingToolResultsAfterIdleParams = {
  agent: unknown;
  sessionManager: unknown;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
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

export async function flushPendingToolResultsAfterIdle(
  opts: FlushPendingToolResultsAfterIdleParams,
): Promise<void> {
  const agent = opts.agent as IdleAwareAgent | null | undefined;
  const sessionManager = opts.sessionManager as ToolResultFlushManager | null | undefined;
  const timedOut = await waitForAgentIdleBestEffort(
    agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );
  if (timedOut && opts.clearPendingOnTimeout && sessionManager?.clearPendingToolResults) {
    sessionManager.clearPendingToolResults();
    return;
  }
  sessionManager?.flushPendingToolResults?.();
}
