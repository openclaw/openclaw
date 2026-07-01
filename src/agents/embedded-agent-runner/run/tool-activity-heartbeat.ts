/**
 * Tool-activity heartbeat for subagent session idle timeout.
 *
 * When a subagent executes tool calls (web_fetch, read, exec, etc.), the LLM
 * stream is idle.  The LLM idle-watchdog (llm-idle-timeout.ts) aborts the
 * stream if no new tokens arrive within DEFAULT_LLM_IDLE_TIMEOUT_SECONDS (120s).
 *
 * This module lets the tool-execution path call `notifyToolActivity(signal)`
 * after every completed tool-call so the watchdog sees activity and resets its
 * 30-second sub-heartbeat — a tool that runs for minutes still keeps the
 * session alive as long as it makes progress.
 *
 * The 30s window is intentionally shorter than the 120s default so a slow
 * tool call has multiple chances to refresh the timer before the LLM watchdog
 * fires.
 */
const TOOL_ACTIVITY_HEARTBEAT_MS = 30_000;

const toolActivityListeners = new WeakMap<AbortSignal, Set<() => void>>();

/**
 * Subscribe to tool-activity heartbeats associated with a given AbortSignal.
 * Returns an unsubscribe function.
 */
export function onToolActivity(
  signal: AbortSignal,
  listener: () => void,
): () => void {
  const listeners = toolActivityListeners.get(signal) ?? new Set<() => void>();
  listeners.add(listener);
  toolActivityListeners.set(signal, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      toolActivityListeners.delete(signal);
    }
  };
}

/**
 * Notify all tool-activity listeners registered for the given AbortSignal.
 */
export function notifyToolActivity(
  signal: AbortSignal | undefined,
): void {
  if (!signal) {
    return;
  }
  for (const listener of toolActivityListeners.get(signal) ?? []) {
    listener();
  }
}

export { TOOL_ACTIVITY_HEARTBEAT_MS };
