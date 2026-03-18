type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
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
  skipWaitForIdle?: boolean;
}): Promise<void> {
  // Once a run is already aborted, waiting for the agent to become idle buys us
  // nothing. The provider/tool work may keep running in the background, but the
  // caller needs the session lock released immediately so the next attempt does
  // not queue behind a "timed out" turn for another cleanup window.
  if (opts.skipWaitForIdle) {
    if (opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
      opts.sessionManager.clearPendingToolResults();
      return;
    }
    opts.sessionManager?.flushPendingToolResults?.();
    return;
  }

  const timedOut = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );
  if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
    opts.sessionManager.clearPendingToolResults();
    return;
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
