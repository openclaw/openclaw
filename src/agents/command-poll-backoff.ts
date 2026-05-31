import type { SessionState } from "../logging/diagnostic-session-state.js";

const BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000];

/** Calculates the capped retry delay for consecutive no-output command polls. */
export function calculateBackoffMs(consecutiveNoOutputPolls: number): number {
  const index = Math.min(consecutiveNoOutputPolls, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index] ?? 60000;
}

/** Records a command poll and returns the suggested retry delay for the next poll. */
export function recordCommandPoll(
  state: SessionState,
  commandId: string,
  hasNewOutput: boolean,
): number {
  if (!state.commandPollCounts) {
    state.commandPollCounts = new Map();
  }

  const existing = state.commandPollCounts.get(commandId);
  const now = Date.now();

  if (hasNewOutput) {
    state.commandPollCounts.set(commandId, { count: 0, lastPollAt: now });
    return BACKOFF_SCHEDULE_MS[0] ?? 5000;
  }

  const newCount = (existing?.count ?? -1) + 1;
  state.commandPollCounts.set(commandId, { count: newCount, lastPollAt: now });

  return calculateBackoffMs(newCount);
}

/** Reads the current retry delay for a command without mutating poll state. */
export function getCommandPollSuggestion(
  state: SessionState,
  commandId: string,
): number | undefined {
  const pollData = state.commandPollCounts?.get(commandId);
  if (!pollData) {
    return undefined;
  }
  return calculateBackoffMs(pollData.count);
}

/** Clears a command's poll state after progress, completion, or cancellation. */
export function resetCommandPollCount(state: SessionState, commandId: string): void {
  state.commandPollCounts?.delete(commandId);
}

/** Prunes stale command poll records to keep per-session state bounded. */
export function pruneStaleCommandPolls(state: SessionState, maxAgeMs = 3600000): void {
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
