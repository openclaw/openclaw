import { entryMatches } from "./session-projection-entry-match.js";
import {
  createSessionProjectionEntries,
  sameTranscriptIdentity,
  type SessionProjectionEntry,
} from "./session-projection-message-identity.js";
import { insertSessionProjectionEntry as insertEntry } from "./session-projection-order.js";
import type { SessionProjectionEvent, SessionProjectionState } from "./session-projection.js";

/** Retire display occurrences while preserving independently owned run and send bodies. */
export function retainSessionProjectionResidency(
  state: SessionProjectionState,
  event: Extract<SessionProjectionEvent, { type: "residencyChanged" }>,
): SessionProjectionState {
  const admitted = new Map<unknown, number>();
  for (const message of event.messages) {
    admitted.set(message, (admitted.get(message) ?? 0) + 1);
  }
  const pinnedRuns = new Set(event.pinnedRunIds);
  const inferredMessages = new Set(
    Object.values(state.runs).flatMap((run) =>
      run.inferredSnapshotTerminal ? [run.inferredSnapshotTerminal.entry.message] : [],
    ),
  );
  const inferredCandidates = Object.values(state.runs).flatMap((run) =>
    run.inferredSnapshotTerminal ? [run.inferredSnapshotTerminal.matchedIdentity] : [],
  );
  const existing = new Map(state.entries.map((entry) => [entry.message, entry]));
  const incoming = createSessionProjectionEntries(event.messages);
  const retainedIndexes = new Set<number>();
  // Residency grants occurrences, not every copy of an object. Consume from
  // the tail so ordinary admission and newest-output selection agree.
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index]!;
    const count = admitted.get(entry.message) ?? 0;
    if (count) {
      admitted.set(entry.message, count - 1);
      retainedIndexes.add(index);
      continue;
    }
    const run = entry.identity?.runId ? state.runs[entry.identity.runId] : undefined;
    const provisional =
      entry.live &&
      entry.identity &&
      !entry.identity.id &&
      entry.identity.sequence === null &&
      !entry.identity.externalSource;
    const pinned =
      entry.pending ||
      provisional ||
      inferredMessages.has(entry.message) ||
      inferredCandidates.some((identity) => sameTranscriptIdentity(identity, entry.identity)) ||
      (run &&
        entry.message === run.message &&
        (run.status === "streaming" || run.status === "error" || pinnedRuns.has(run.runId)));
    if (
      pinned &&
      !(
        entry.pending &&
        incoming.some(
          (candidate) =>
            candidate.identity !== null &&
            (candidate.identity.id !== null || candidate.identity.sequence !== null) &&
            !existing.get(candidate.message)?.pending &&
            entryMatches(entry, candidate, true),
        )
      )
    ) {
      retainedIndexes.add(index);
    }
  }
  // Retirement changes residency, never the canonical relative order of
  // retained live/pending rows around durable sequence boundaries.
  let entries: readonly SessionProjectionEntry[] = state.entries.filter((_, index) =>
    retainedIndexes.has(index),
  );
  for (const entry of incoming) {
    const count = admitted.get(entry.message) ?? 0;
    if (count) {
      admitted.set(entry.message, count - 1);
      entries = insertEntry(entries, entry, state.runs);
    }
  }
  const retained = new Set(entries.map((entry) => entry.message));
  let runs = state.runs;
  for (const [runId, run] of Object.entries(state.runs)) {
    if (
      run.message === undefined ||
      retained.has(run.message) ||
      run.status === "streaming" ||
      run.status === "error" ||
      run.inferredSnapshotTerminal ||
      pinnedRuns.has(runId)
    ) {
      continue;
    }
    if (runs === state.runs) {
      runs = Object.assign({}, runs);
    }
    const { message: _message, ...retired } = run;
    Object.assign(runs, { [runId]: retired });
  }
  return entries.length === state.entries.length &&
    entries.every((entry, index) => entry === state.entries[index]) &&
    runs === state.runs
    ? state
    : { ...state, entries, messages: entries.map((entry) => entry.message), runs };
}
