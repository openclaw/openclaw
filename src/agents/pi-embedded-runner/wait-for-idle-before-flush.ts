type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

type AgentIdleWaitState = {
  timedOut: boolean;
  resolved: boolean;
};

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<AgentIdleWaitState> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return { timedOut: false, resolved: false };
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
    return {
      timedOut: outcome === idleTimedOut,
      resolved: outcome === idleResolved,
    };
  } catch {
    // Best-effort during cleanup.
    return { timedOut: false, resolved: false };
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
  const idleState = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
  );
  if (idleState.timedOut) {
    if (opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
      opts.sessionManager.clearPendingToolResults();
    }
    return;
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
