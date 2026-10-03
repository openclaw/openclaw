/**
 * Waits for tool-result streams to become idle before flushing output.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { guardSessionManager } from "../session-tool-result-guard-wrapper.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = Pick<
  ReturnType<typeof guardSessionManager>,
  "getSessionTarget" | "getSessionId" | "hasPendingToolResults" | "flushPendingToolResultsAsync"
>;

const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForAgentIdleBestEffort(
  agent: IdleAwareAgent | null | undefined,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const waitForIdle = agent?.waitForIdle;
  if (abortSignal?.aborted || typeof waitForIdle !== "function") {
    return;
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await racePromiseWithAbortSignal(
      Promise.race([
        waitForIdle.call(agent).then(() => undefined),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, resolvedTimeoutMs);
          timeoutHandle.unref?.();
        }),
      ]),
      abortSignal,
    );
  } catch {
    // Best-effort during cleanup.
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
  /** Cancels only the optional idle wait, never required transcript persistence. */
  abortSignal?: AbortSignal;
}): Promise<void> {
  const isImmediateTimeout = opts.timeoutMs !== undefined && opts.timeoutMs <= 0;
  if (!isImmediateTimeout) {
    await waitForAgentIdleBestEffort(
      opts.agent,
      opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
      opts.abortSignal,
    );
  }
  const { sessionManager } = opts;
  if (
    sessionManager?.flushPendingToolResultsAsync &&
    sessionManager.hasPendingToolResults?.() !== false
  ) {
    await sessionManager.flushPendingToolResultsAsync();
  }
}
