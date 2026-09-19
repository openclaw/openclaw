/** Terminal identity rules used to reconcile live and durable assistant projections. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import {
  hasDisplayableSessionMessage,
  readSessionMessageDisplayContent,
} from "./session-projection-message-content.js";
import {
  readSessionMessageIdentity,
  sameAssistantPersistenceReceipt,
  type SessionMessageIdentity,
} from "./session-projection-message-identity.js";

/**
 * The class of rows the #148297 relaxation newly admits as finals: persisted
 * with the run's terminal tool stop reason while carrying no tool-call
 * content. Both adoption directions and every position rule scope to this
 * predicate, so pre-existing match semantics stay untouched.
 */
export function isToolUsePersistedFinalRow(message: unknown): boolean {
  const record = readRecord(message);
  return record?.["stopReason"] === "toolUse" && !isSessionProjectionToolContinuation(message);
}

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

/** Tool-bearing assistant rows are continuations even without a tool stop reason. */
export function isSessionProjectionToolContinuation(message: unknown): boolean {
  const record = readRecord(message);
  if (
    Array.isArray(record?.content) &&
    record.content.some((block) => {
      const type = readRecord(block)?.type;
      return type === "toolCall" || type === "toolUse" || type === "functionCall";
    })
  ) {
    return true;
  }
  // A tool stop reason alone marks a continuation only when the row carries no
  // displayable text: a run's selected final answer is persisted with the
  // run's terminal stop reason even when the row itself is pure text, and such
  // a final must still reconcile with its unkeyed live projection (#148297).
  return record?.stopReason === "toolUse" && !hasDisplayableSessionMessage(message);
}

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
  if (identity?.role === "assistant" && !identity.isImported && identity.idempotencyKey) {
    return `key:assistant:${identity.idempotencyKey}`;
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
  if (sameAssistantPersistenceReceipt(current, incoming)) {
    return true;
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

export function readFinalContentIdentity(message: unknown): string | null {
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
    run.status === "streaming" ||
    matches.length === 0
  ) {
    return null;
  }
  const terminalContent = readFinalContentIdentity(current.message);
  if (!terminalContent || readFinalContentIdentity(run.message) !== terminalContent) {
    return null;
  }
  let snapshotIndexes: Map<TerminalProjectionEntry, number> | undefined;
  let firstUserIndex = -1;
  let lastAssistantIndex = -1;
  const ensureRunIndexes = (): void => {
    if (snapshotIndexes) {
      return;
    }
    const runId = current.identity?.runId;
    const indexes = new Map<TerminalProjectionEntry, number>();
    if (runId) {
      snapshot.forEach((candidate, index) => {
        if (candidate.identity?.runId === runId) {
          // Keep indexOf's first-occurrence identity when a snapshot repeats an entry.
          if (!indexes.has(candidate)) {
            indexes.set(candidate, index);
          }
          if (candidate.identity.role === "user" && firstUserIndex < 0) {
            firstUserIndex = index;
          } else if (candidate.identity.role === "assistant") {
            lastAssistantIndex = index;
          }
        }
      });
    }
    snapshotIndexes = indexes;
  };
  const hasCompletedRunSnapshotContext = (entry: TerminalProjectionEntry): boolean => {
    const runId = current.identity?.runId;
    if (!runId || entry.identity?.runId !== runId) {
      return false;
    }
    ensureRunIndexes();
    const entryIndex = snapshotIndexes?.get(entry);
    return (
      entryIndex !== undefined &&
      firstUserIndex >= 0 &&
      firstUserIndex < entryIndex &&
      lastAssistantIndex <= entryIndex
    );
  };
  // A toolUse-persisted row can only be the run's selected final when no later
  // same-run assistant row exists in the snapshot: a following assistant or
  // tool row proves the run continued past it, so the live terminal must stay.
  const isLastSameRunAssistantRow = (entry: TerminalProjectionEntry): boolean => {
    const runId = current.identity?.runId;
    if (!runId || entry.identity?.runId !== runId) {
      return false;
    }
    ensureRunIndexes();
    const entryIndex = snapshotIndexes?.get(entry);
    return entryIndex !== undefined && lastAssistantIndex >= 0 && entryIndex >= lastAssistantIndex;
  };
  const durableTerminalMatches = matches.filter((entry) => {
    const metadata = readRecord(readRecord(entry.message)?.["__openclaw"]);
    return (
      (metadata?.runTerminal === true ||
        (entry.identity?.runId === current.identity?.runId &&
          (hasTerminalStopReason(entry.message) ||
            // A row persisted with the run's terminal tool stop reason and no
            // tool-call content is the run's selected final; it must reconcile
            // with its unkeyed live projection (#148297). Unmarked rows stay
            // separate — partial history must not adopt the terminal — and the
            // row must be the run's last assistant row in the snapshot, since
            // a later same-run row proves the run continued past it.
            (readRecord(entry.message)?.["stopReason"] === "toolUse" &&
              !isSessionProjectionToolContinuation(entry.message) &&
              isLastSameRunAssistantRow(entry)))) ||
        hasCompletedRunSnapshotContext(entry)) &&
      readFinalContentIdentity(entry.message) === terminalContent
    );
  });
  const entry = durableTerminalMatches.length === 1 ? durableTerminalMatches[0] : undefined;
  if (!entry) {
    return null;
  }
  const metadata = readRecord(readRecord(entry.message)?.["__openclaw"]);
  return {
    entry,
    inferred: metadata?.runTerminal !== true && !hasTerminalStopReason(entry.message),
  };
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
