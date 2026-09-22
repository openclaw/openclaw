/**
 * Waits for tool-result streams to become idle before flushing output.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = Pick<
  ReturnType<typeof guardSessionManager>,
  "getSessionTarget" | "hasPendingToolResults" | "flushPendingToolResults"
>;

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
  }
  const { sessionManager } = opts;
  if (
    sessionManager?.flushPendingToolResults &&
    sessionManager.hasPendingToolResults?.() !== false
  ) {
    await withSessionManagerWrite(sessionManager, () => sessionManager.flushPendingToolResults?.());
  }
}
