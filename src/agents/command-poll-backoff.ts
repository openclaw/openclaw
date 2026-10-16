/**
 * Exponential backoff helpers for command-output polling. Session diagnostics
 * use this state to slow no-output polls while resetting promptly on output.
 */
import type { SessionState } from "../logging/diagnostic-session-state.js";

const BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000];

export function recordCommandPoll(
  state: SessionState,
  commandId: string,
  hasNewOutput: boolean,
): number {
  const counts = (state.commandPollCounts ??= new Map());
  const existing = counts.get(commandId);
  const now = Date.now();
  const count = hasNewOutput ? 0 : (existing?.count ?? -1) + 1;
  counts.set(commandId, { count, lastPollAt: now });
  return BACKOFF_SCHEDULE_MS[Math.min(count, BACKOFF_SCHEDULE_MS.length - 1)] ?? 60000;
}

export function resetCommandPollCount(state: SessionState, commandId: string): void {
  state.commandPollCounts?.delete(commandId);
}

export function pruneStaleCommandPollsCore(state: SessionState, maxAgeMs = 3600000): void {
  if (!state.commandPollCounts) {
    return;
  }

  const now = Date.now();
  for (const [commandId, data] of state.commandPollCounts.entries()) {
    if (now - data.lastPollAt > maxAgeMs) {
      state.commandPollCounts.delete(commandId);
    }
  }
}
