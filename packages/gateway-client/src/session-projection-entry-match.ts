import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readNonemptyString } from "@openclaw/normalization-core/string-coerce";
import {
  isSessionProjectionToolContinuation,
  isToolUsePersistedFinalRow,
  readFinalContentIdentity,
} from "./session-projection-final-identity.js";
import {
  readAssistantStreamSegmentIdentity,
  sameTranscriptIdentity,
  sameAssistantPersistenceReceipt,
  type SessionProjectionEntry,
} from "./session-projection-message-identity.js";

export function entryMatches(
  left: SessionProjectionEntry,
  right: SessionProjectionEntry,
  allowSnapshotPromotion = false,
): boolean {
  const leftSegment = readAssistantStreamSegmentIdentity(left.message);
  const rightSegment = readAssistantStreamSegmentIdentity(right.message);
  // One transcript row can contain separate commentary and tool display parts.
  if (leftSegment?.itemId !== rightSegment?.itemId) {
    return false;
  }
  if (sameTranscriptIdentity(left.identity, right.identity)) {
    return true;
  }
  if (sameAssistantPersistenceReceipt(left.identity, right.identity)) {
    return true;
  }
  if (
    left.identity?.role === "assistant" &&
    right.identity?.role === "assistant" &&
    left.identity.idempotencyKey &&
    right.identity.idempotencyKey &&
    left.identity.idempotencyKey !== right.identity.idempotencyKey
  ) {
    return false;
  }
  const durableEntry = left.identity?.id ? left : right.identity?.id ? right : null;
  const provisionalEntry = durableEntry === left ? right : durableEntry === right ? left : null;
  const durableMetadata = readRecord(readRecord(durableEntry?.message)?.["__openclaw"]);
  if (
    durableEntry?.identity?.role === "assistant" &&
    provisionalEntry?.identity?.role === "assistant" &&
    !durableEntry.identity.isImported &&
    !provisionalEntry.identity.isImported &&
    !provisionalEntry.identity.id
  ) {
    const durableSegment = durableEntry === left ? leftSegment : rightSegment;
    const provisionalSegment = durableEntry === left ? rightSegment : leftSegment;
    // Terminal cleanup can materialize commentary before cursor history catches up.
    // Adopt its exact item/run without joining distinct durable rows or equal prose.
    if (
      provisionalEntry.identity.sequence === null &&
      durableSegment?.runId &&
      durableSegment.runId === provisionalSegment?.runId &&
      durableSegment.itemId === provisionalSegment.itemId
    ) {
      return true;
    }
    // Commentary and tool continuations cannot own an unkeyed final answer.
    if (
      provisionalEntry.live &&
      !durableSegment &&
      !isSessionProjectionToolContinuation(durableEntry.message) &&
      // Admitting a text-only toolUse-persisted final must not let it merge
      // with a *different* same-run answer in either direction: the kept side
      // suppresses or replaces the other without any content comparison
      // downstream. Scope the content requirement to that newly admitted
      // class only; pre-existing matches (identity promotions, non-toolUse
      // rows) keep their established semantics.
      (!isToolUsePersistedFinalRow(durableEntry.message) ||
        readFinalContentIdentity(durableEntry.message) ===
          readFinalContentIdentity(provisionalEntry.message)) &&
      provisionalEntry.identity.sequence === null &&
      (provisionalEntry.afterSequence === undefined ||
        (provisionalEntry.afterSequence !== null &&
          durableEntry.identity.sequence !== null &&
          durableEntry.identity.sequence > provisionalEntry.afterSequence)) &&
      durableEntry.identity.runId &&
      durableEntry.identity.runId === provisionalEntry.identity.runId &&
      (readNonemptyString(durableMetadata?.mirrorOrigin) === null ||
        durableMetadata?.runTerminal === true)
    ) {
      return true;
    }
  }
  const persisted = left.identity;
  const observed = right.identity;
  if (
    allowSnapshotPromotion &&
    right.live &&
    persisted &&
    observed &&
    persisted.role === observed.role &&
    !persisted.isImported &&
    !observed.isImported &&
    persisted.id &&
    !observed.id &&
    persisted.sequence !== null &&
    persisted.sequence === observed.sequence
  ) {
    // Only current-scope history can promote an observed native sequence.
    return true;
  }
  if (left.pending && right.pending) {
    return Boolean(
      left.identity?.role === right.identity?.role &&
      left.pendingRunId &&
      left.pendingRunId === right.pendingRunId,
    );
  }
  const pending = left.pending ? left : right.pending ? right : null;
  const authoritative = pending === left ? right : pending === right ? left : null;
  return Boolean(
    pending &&
    authoritative &&
    pending.identity &&
    authoritative.identity &&
    pending.identity.role === authoritative.identity.role &&
    !pending.identity.isImported &&
    !authoritative.identity.isImported &&
    pending.pendingRunId &&
    pending.pendingRunId === (authoritative.identity.sendId ?? authoritative.identity.runId) &&
    (pending.identity.sequence === null ||
      authoritative.identity.sequence === null ||
      pending.identity.sequence === authoritative.identity.sequence),
  );
}
