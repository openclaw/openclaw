/**
 * Waits for tool-result streams to become idle before flushing output.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { raceWithTimeout } from "@openclaw/retry";
import type { Agent } from "../runtime/index.js";
import type { guardSessionManager } from "../session-tool-result-guard-wrapper.js";

type ToolResultFlushManager = Pick<
  ReturnType<typeof guardSessionManager>,
  "getSessionTarget" | "getSessionId" | "hasPendingToolResults" | "flushPendingToolResultsAsync"
>;

const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: Pick<Agent, "waitForIdle"> | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  /** Cancels only the optional idle wait, never required transcript persistence. */
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { agent, sessionManager, timeoutMs, abortSignal } = opts;
  const isImmediateTimeout = timeoutMs !== undefined && timeoutMs <= 0;
  if (agent && !abortSignal?.aborted && !isImmediateTimeout) {
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);

    try {
      await raceWithTimeout(agent.waitForIdle(), resolvedTimeoutMs, () => undefined, {
        ref: false,
        signal: abortSignal,
      });
    } catch {
      // Best-effort during cleanup.
    }
  }
  if (
    sessionManager?.flushPendingToolResultsAsync &&
    sessionManager.hasPendingToolResults?.() !== false
  ) {
    await sessionManager.flushPendingToolResultsAsync();
  }
}
