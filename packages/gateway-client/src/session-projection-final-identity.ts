/** Terminal identity rules used to reconcile live and durable assistant projections. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  hasDisplayableSessionMessage,
  readSessionMessageDisplayContent,
} from "./session-projection-message-content.js";
import {
  readSessionMessageIdentity,
  type SessionMessageIdentity,
} from "./session-projection-message-identity.js";

type TerminalProjectionEntry = {
  message: unknown;
  identity: SessionMessageIdentity | null;
  live: boolean;
};

type TerminalProjectionRun = {
  message?: unknown;
  status: string;
  acceptedFinalMessageIdentities?: readonly string[];
};

function readPersistedFinalIdentity(message: unknown): string | null {
  const identity = readSessionMessageIdentity(message);
  if (identity?.externalSource) {
    return `import:${identity.role}:${identity.externalSource}`;
  }
  if (identity?.id && !identity.isImported) {
    return `id:${identity.role}:${identity.id}`;
  }
  if (identity?.sequence !== null && identity?.sequence !== undefined) {
    return `seq:${identity.role}:${identity.sequence}`;
  }
  return null;
}

function hasCompatiblePersistedFinalIdentity(currentMessage: unknown, incomingMessage: unknown) {
  const current = readSessionMessageIdentity(currentMessage);
  const incoming = readSessionMessageIdentity(incomingMessage);
  if (!current || !incoming || current.role !== incoming.role) {
    return false;
  }
  if (current.isImported || incoming.isImported) {
    if (!current.isImported || !incoming.isImported) {
      return false;
    }
    if (current.externalSource && incoming.externalSource) {
      return current.externalSource === incoming.externalSource;
    }
    return (
      current.sequence !== null &&
      incoming.sequence !== null &&
      current.sequence === incoming.sequence
    );
  }
  if (current.id && incoming.id) {
    return current.id === incoming.id;
  }
  return (
    current.sequence !== null &&
    incoming.sequence !== null &&
    current.sequence === incoming.sequence
  );
}

function readFinalContentIdentity(message: unknown): string | null {
  const display = readSessionMessageDisplayContent(message);
  if (!display.text && !display.hasNonText) {
    return null;
  }
  const identity = readSessionMessageIdentity(message);
  const record = readRecord(message);
  const metadata = readRecord(record?.["__openclaw"]);
  try {
    return `content:${stableStringify([
      identity?.role ?? "assistant",
      display.text,
      display.hasNonText ? (record?.content ?? null) : null,
      metadata?.media ?? null,
      identity?.isImported
        ? [
            metadata?.importedFrom ?? null,
            metadata?.cliSessionId ?? null,
            metadata?.externalId ?? null,
          ]
        : null,
    ])}`;
  } catch {
    return null;
  }
}

function hasTerminalStopReason(message: unknown): boolean {
  const stopReason = readRecord(message)?.stopReason;
  return (
    stopReason === "stop" ||
    stopReason === "length" ||
    stopReason === "error" ||
    stopReason === "aborted" ||
    stopReason === "end_turn"
  );
}

function hasCompletedRunSnapshotContext(
  entry: TerminalProjectionEntry,
  snapshot: readonly TerminalProjectionEntry[],
  runId: string | null,
): boolean {
  if (!runId || entry.identity?.runId !== runId) {
    return false;
  }
  const entryIndex = snapshot.indexOf(entry);
  if (entryIndex < 0) {
    return false;
  }
  const hasEarlierUser = snapshot
    .slice(0, entryIndex)
    .some((candidate) => candidate.identity?.role === "user" && candidate.identity.runId === runId);
  const hasLaterAssistant = snapshot
    .slice(entryIndex + 1)
    .some(
      (candidate) => candidate.identity?.role === "assistant" && candidate.identity.runId === runId,
    );
  return hasEarlierUser && !hasLaterAssistant;
}

/** Terminal evidence shared by snapshot promotion and live replay reconciliation. */
function hasTerminalProjectionEvidence(
  entry: TerminalProjectionEntry,
  snapshot: readonly TerminalProjectionEntry[],
  runId: string | null,
): boolean {
  const metadata = readRecord(readRecord(entry.message)?.["__openclaw"]);
  return (
    metadata?.runTerminal === true ||
    (entry.identity?.runId === runId && hasTerminalStopReason(entry.message)) ||
    hasCompletedRunSnapshotContext(entry, snapshot, runId)
  );
}

/** Explicit terminal markers that later history cannot contradict. */
function hasExplicitTerminalEvidence(entry: TerminalProjectionEntry): boolean {
  const metadata = readRecord(readRecord(entry.message)?.["__openclaw"]);
  return metadata?.runTerminal === true || hasTerminalStopReason(entry.message);
}

/** Read stable persisted identity first, falling back to canonical display content. */
export function readSessionProjectionFinalMessageIdentity(message: unknown): string | null {
  if (!hasDisplayableSessionMessage(message)) {
    return null;
  }
  return readPersistedFinalIdentity(message) ?? readFinalContentIdentity(message);
}

/** Check whether a displayable terminal may recover a prior empty terminal. */
export function canRecoverSessionProjectionFinal(
  currentMessage: unknown,
  incomingMessage: unknown,
): boolean {
  if (hasDisplayableSessionMessage(currentMessage)) {
    return false;
  }
  const currentIdentity = readPersistedFinalIdentity(currentMessage);
  return (
    currentIdentity === null || hasCompatiblePersistedFinalIdentity(currentMessage, incomingMessage)
  );
}

/** Check whether a run has already accepted the same terminal reply. */
export function hasSessionProjectionAcceptedFinal(
  run: TerminalProjectionRun | undefined,
  message: unknown,
): boolean {
  const identity = readSessionProjectionFinalMessageIdentity(message);
  return Boolean(
    identity &&
    run &&
    (run.acceptedFinalMessageIdentities?.includes(identity) ||
      readSessionProjectionFinalMessageIdentity(run.message) === identity),
  );
}

/** Match an unsequenced live terminal to exactly one durable same-run terminal row. */
export function findUniqueSnapshotTerminalMatch(
  current: TerminalProjectionEntry,
  matches: readonly TerminalProjectionEntry[],
  run: TerminalProjectionRun | undefined,
  snapshot: readonly TerminalProjectionEntry[],
): { entry: TerminalProjectionEntry; inferred: boolean } | null {
  if (
    !current.live ||
    current.identity?.role !== "assistant" ||
    current.identity.id ||
    current.identity.sequence !== null ||
    !run ||
    run.status === "streaming"
  ) {
    return null;
  }
  const terminalContent = readFinalContentIdentity(current.message);
  if (!terminalContent || readFinalContentIdentity(run.message) !== terminalContent) {
    return null;
  }
  const entry = findUniqueTerminalContentMatch(
    matches,
    terminalContent,
    snapshot,
    current.identity?.runId ?? null,
  );
  if (!entry) {
    return null;
  }
  return {
    entry,
    inferred: !hasExplicitTerminalEvidence(entry),
  };
}

/**
 * Pick the unique durable row that carries terminal evidence and matches the
 * replay content; shared by snapshot promotion and live reconciliation.
 */
function findUniqueTerminalContentMatch<T extends TerminalProjectionEntry>(
  matches: readonly T[],
  content: string,
  snapshot: readonly TerminalProjectionEntry[],
  runId: string | null,
): T | null {
  const candidates = matches.filter(
    (entry) =>
      hasTerminalProjectionEvidence(entry, snapshot, runId) &&
      readFinalContentIdentity(entry.message) === content,
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Match an unsequenced live replay to exactly one durable row sharing the same
 * terminal evidence and full display content as snapshot reconciliation.
 */
export function findUniqueLiveTerminalMatch<T extends TerminalProjectionEntry>(
  current: TerminalProjectionEntry,
  matches: readonly T[],
  snapshot: readonly TerminalProjectionEntry[],
): T | null {
  const content = readFinalContentIdentity(current.message);
  if (!content) {
    return null;
  }
  return findUniqueTerminalContentMatch(
    matches,
    content,
    snapshot,
    current.identity?.runId ?? null,
  );
}

/** Check whether ordinary single-match promotion needs terminal-content verification. */
export function isUnsequencedLiveTerminal(
  current: TerminalProjectionEntry,
  run: TerminalProjectionRun | undefined,
): boolean {
  return Boolean(
    current.live &&
    current.identity?.role === "assistant" &&
    !current.identity.id &&
    current.identity.sequence === null &&
    run &&
    run.status !== "streaming" &&
    readFinalContentIdentity(current.message) === readFinalContentIdentity(run.message),
  );
}

/**
 * Keep a position-inferred live match recoverable until later history confirms
 * it; shared with snapshot reconciliation's tentative recovery record.
 */
export function withTentativeRecovery<TRun extends { message?: unknown; status: string }>(
  run: TRun | undefined,
  entry: TerminalProjectionEntry,
  matched: TerminalProjectionEntry,
): TRun | null {
  if (
    !run ||
    !matched.identity ||
    !isUnsequencedLiveTerminal(entry, run) ||
    hasExplicitTerminalEvidence(matched)
  ) {
    return null;
  }
  return { ...run, inferredSnapshotTerminal: { entry, matchedIdentity: matched.identity } };
}

/**
 * Check whether a live unsequenced assistant reply is a distinct later reply of
 * the run rather than its immutable first final. Tentative recovery cannot
 * represent these entries, so suppression must not drop them silently.
 * Sequence-fenced tails reconcile against their later durable row instead.
 */
function isDistinctLaterLiveFinal(
  current: TerminalProjectionEntry,
  run: TerminalProjectionRun | undefined,
): boolean {
  const content = readFinalContentIdentity(current.message);
  return Boolean(
    current.live &&
    current.identity?.role === "assistant" &&
    !current.identity.id &&
    current.identity.sequence === null &&
    current.afterSequence === undefined &&
    run &&
    run.status !== "streaming" &&
    content !== null &&
    content !== readFinalContentIdentity(run.message),
  );
}

/**
 * Keep a later distinct final visible when tentative recovery cannot represent
 * it: without explicit terminal evidence, a contradicted position match would
 * have no recovery record to restore the suppressed reply.
 */
export function shouldKeepLaterFinalVisible(
  entry: TerminalProjectionEntry,
  matched: TerminalProjectionEntry,
  run: TerminalProjectionRun | undefined,
): boolean {
  return !hasExplicitTerminalEvidence(matched) && isDistinctLaterLiveFinal(entry, run);
}
