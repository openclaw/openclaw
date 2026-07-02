/**
 * Waits for tool-result streams to become idle before flushing output.
 */
import { setImmediate } from "node:timers";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const waitForIdle = agent?.waitForIdle;
  if (typeof waitForIdle !== "function") {
    return false;
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);

  const idleResolved = Symbol("idle");
  const idleTimedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForIdle.call(agent).then(() => idleResolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(idleTimedOut), resolvedTimeoutMs);
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
}): Promise<void> {
  const isImmediateTimeout = opts.timeoutMs !== undefined && opts.timeoutMs <= 0;
  if (!isImmediateTimeout) {
    await waitForAgentIdleBestEffort(
      opts.agent,
      opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
    );
    // Drain one event-loop iteration before flushing so that pending
    // I/O callbacks (e.g. Feishu message-tool HTTP responses) can write
    // real tool results and clear the pending map before synthetics are
    // injected (#84134).
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
