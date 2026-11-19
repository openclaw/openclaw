import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionMessageSequence,
  type SessionProjectionEntry,
} from "./session-projection-message-identity.js";
import type { SessionProjectionRun, SessionProjectionState } from "./session-projection.js";

export function insertSessionProjectionEntry(
  entries: readonly SessionProjectionEntry[],
  incoming: SessionProjectionEntry,
  runs?: Readonly<Record<string, SessionProjectionRun>>,
): SessionProjectionEntry[] {
  const sequence = incoming.identity?.sequence;
  let nextIndex =
    sequence === undefined || sequence === null
      ? -1
      : entries.findIndex((entry) => {
          const candidate = entry.identity?.sequence;
          return candidate !== undefined && candidate !== null && candidate > sequence;
        });
  if (sequence !== undefined && sequence !== null && nextIndex < 0) {
    nextIndex = entries.length;
  }
  if (incoming.localOutput && incoming.atHistoryStart) {
    nextIndex = entries.findIndex((entry) => !entry.localOutput || !entry.atHistoryStart);
  }
  if (incoming.localOutput && incoming.afterSequence != null) {
    const after = incoming.afterSequence;
    nextIndex = entries.findIndex(
      (entry) =>
        (entry.identity?.sequence ?? readSessionMessageSequence(entry.message) ?? -1) > after,
    );
  }
  if (incoming.identity?.role === "user" && incoming.identity.runId) {
    const runId = incoming.identity.runId;
    const terminalMessage = runs?.[runId]?.message;
    const belongsToRun = (entry: SessionProjectionEntry) =>
      (entry.identity?.role === "assistant" &&
        (entry.identity.runId === runId || entry.message === terminalMessage)) ||
      (entry.pending &&
        entry.identity?.role === "user" &&
        !entry.identity.isImported &&
        readRecord(readRecord(entry.message)?.["__openclaw"])?.steerTargetRunId === runId);
    if (sequence !== undefined && sequence !== null) {
      // Replies and optimistic steers can arrive before the original prompt is
      // persisted. Keep them after it; durable sequence still wins over ownership.
      const before: SessionProjectionEntry[] = [];
      const dependents: SessionProjectionEntry[] = [];
      for (const entry of entries.slice(0, nextIndex)) {
        (entry.identity?.sequence === null && belongsToRun(entry) ? dependents : before).push(
          entry,
        );
      }
      return [...before, incoming, ...dependents, ...entries.slice(nextIndex)];
    }
    const terminalIndex = entries.findIndex(belongsToRun);
    if (terminalIndex >= 0 && (nextIndex < 0 || terminalIndex < nextIndex)) {
      nextIndex = terminalIndex;
    }
  }
  return nextIndex < 0
    ? [...entries, incoming]
    : [...entries.slice(0, nextIndex), incoming, ...entries.slice(nextIndex)];
}

export function localOutputPlacement(
  state: SessionProjectionState,
  sourceEmpty?: true,
): Pick<SessionProjectionEntry, "afterSequence" | "atHistoryStart"> {
  // Retain placement, not a fabricated durable sequence, across refreshes.
  const previous = state.entries.findLast(
    (entry) => (entry.identity?.sequence ?? readSessionMessageSequence(entry.message)) != null,
  );
  const afterSequence = previous
    ? (previous.identity?.sequence ?? readSessionMessageSequence(previous.message))
    : undefined;
  const atHistoryStart =
    sourceEmpty &&
    !previous &&
    !state.hasTransportGap &&
    state.entries.every((entry) => entry.localOutput && entry.atHistoryStart) &&
    !Object.values(state.runs).some((run) => run.status === "streaming")
      ? (true as const)
      : undefined;
  return { afterSequence, atHistoryStart };
}
