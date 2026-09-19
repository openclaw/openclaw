import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionMessageEnvelope = {
  /** An unsequenced continuation follows this row; null denotes an unsequenced boundary. */
  afterSequence?: number | null;
  messageId?: unknown;
  messageSeq?: unknown;
  clientRunId?: unknown;
  runId?: unknown;
  idempotencyKey?: unknown;
};

export type SessionMessageIdentity = {
  role: string;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
  /** User submission identity stays stable when a queued turn acquires a new execution run. */
  sendId: string | null;
  runId: string | null;
  isImported: boolean;
  externalSource: string | null;
};

export function readSessionProjectionString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** History and status markers carry transcript order even when they have no chat role. */
export function readSessionMessageSequence(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): number | null {
  const metadata = readRecord(readRecord(message)?.["__openclaw"]);
  return readPositiveSafeInteger(metadata?.seq) ?? readPositiveSafeInteger(envelope?.messageSeq);
}

/** Run ownership normalizes a user-turn suffix without changing its persisted send key. */
export function normalizeSessionProjectionRunId(value: unknown): string | null {
  const runId = readSessionProjectionString(value);
  return runId?.endsWith(":user") ? runId.slice(0, -":user".length) || null : runId;
}

/** Persisted row facts win; assistant run ownership comes from its authoritative producer. */
export function readSessionMessageIdentity(
  message: unknown,
  envelope?: SessionMessageEnvelope,
): SessionMessageIdentity | null {
  const record = readRecord(message);
  const role = readSessionProjectionString(record?.role)?.toLowerCase();
  if (!record || !role) {
    return null;
  }
  const metadata = readRecord(record["__openclaw"]);
  const importedFrom = readSessionProjectionString(metadata?.importedFrom);
  const cliSessionId = readSessionProjectionString(metadata?.cliSessionId);
  const externalId = readSessionProjectionString(metadata?.externalId);
  const position = readRecord(metadata?.transcriptPosition);
  const positionSource = readSessionProjectionString(position?.source);
  const hasCanonicalPosition =
    positionSource !== null &&
    positionSource.length <= 128 &&
    typeof position?.rawSeq === "number" &&
    Number.isSafeInteger(position.rawSeq) &&
    position.rawSeq >= 0;
  // Reader-owned placement keeps a local row native when CLI history enriches its provenance.
  const isImported = !hasCanonicalPosition && Boolean(importedFrom || cliSessionId || externalId);
  const idempotencyKey =
    readSessionProjectionString(metadata?.idempotencyKey) ??
    readSessionProjectionString(record.idempotencyKey) ??
    readSessionProjectionString(envelope?.idempotencyKey) ??
    readSessionProjectionString(envelope?.clientRunId);
  const persistedRunId = normalizeSessionProjectionRunId(idempotencyKey);
  const envelopeRunId = normalizeSessionProjectionRunId(envelope?.runId);
  const metadataRunId = normalizeSessionProjectionRunId(metadata?.runId);
  const fallbackRunId = normalizeSessionProjectionRunId(
    readRecord(record.openclawStreamFallback)?.runId,
  );
  const mirroredMessage = readSessionProjectionString(metadata?.mirrorOrigin) !== null;
  // CLI persistence namespaces assistant send keys; the suffix is the
  // originating Gateway run identity consumed by every projection layer.
  const isCliAssistant =
    role === "assistant" && readSessionProjectionString(record.api)?.toLowerCase() === "cli";
  const canonicalPersistedRunId =
    isCliAssistant && persistedRunId?.startsWith("cli-assistant:")
      ? readSessionProjectionString(persistedRunId.slice("cli-assistant:".length))
      : persistedRunId;
  const runId =
    role === "assistant"
      ? (metadataRunId ??
        envelopeRunId ??
        fallbackRunId ??
        (isCliAssistant || !mirroredMessage ? canonicalPersistedRunId : null))
      : (metadataRunId ?? canonicalPersistedRunId ?? envelopeRunId);
  return {
    role,
    id:
      readSessionProjectionString(metadata?.id) ?? readSessionProjectionString(envelope?.messageId),
    sequence: readSessionMessageSequence(message, envelope),
    idempotencyKey,
    sendId: role === "user" ? (persistedRunId ?? runId) : null,
    runId,
    isImported,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource:
      isImported && importedFrom && cliSessionId && externalId
        ? JSON.stringify([importedFrom, cliSessionId, externalId])
        : null,
  };
}

/** A commentary item's display identity is separate from the transcript row that later owns it. */
export function readAssistantStreamSegmentIdentity(
  message: unknown,
): { itemId: string; runId?: string } | undefined {
  const record = readRecord(message);
  if (readSessionProjectionString(record?.role)?.toLowerCase() !== "assistant") {
    return undefined;
  }
  const fallback = readRecord(record?.openclawStreamFallback);
  const itemId = readSessionProjectionString(fallback?.itemId);
  if (!itemId) {
    return undefined;
  }
  const runId =
    readSessionMessageIdentity(message)?.runId ??
    readSessionProjectionString(record?.runId) ??
    readSessionProjectionString(fallback?.runId);
  return { itemId, ...(runId ? { runId } : {}) };
}

/** A saved occurrence can enrich its live projection, never another durable row. */
export function sameAssistantPersistenceReceipt(
  left: SessionMessageIdentity | null,
  right: SessionMessageIdentity | null,
): boolean {
  return Boolean(
    left?.role === "assistant" &&
    right?.role === "assistant" &&
    !left.isImported &&
    !right.isImported &&
    left.idempotencyKey &&
    left.idempotencyKey === right.idempotencyKey &&
    ((!left.id && left.sequence === null) || (!right.id && right.sequence === null)),
  );
}

/** Local turns have no durable transcript metadata beyond their own optional send key. */
export function isLocallyOptimisticSessionMessage(message: unknown): boolean {
  const record = readRecord(message);
  const role = readSessionProjectionString(record?.role)?.toLowerCase();
  if (role !== "user" && role !== "assistant") {
    return false;
  }
  if (readRecord(record?.openclawStreamFallback)) {
    return false;
  }
  const metadata = readRecord(record?.["__openclaw"]);
  return !metadata || Object.keys(metadata).every((key) => key === "idempotencyKey");
}

export function sameTranscriptIdentity(
  left: SessionMessageIdentity | null,
  right: SessionMessageIdentity | null,
): boolean {
  if (!left || !right || left.role !== right.role) {
    return false;
  }
  if (left.isImported || right.isImported) {
    if (!left.isImported || !right.isImported) {
      return false;
    }
    if (left.externalSource || right.externalSource) {
      return Boolean(left.externalSource && left.externalSource === right.externalSource);
    }
    // Partial provider IDs are unsafe, but a same-scope persisted sequence is authoritative.
    return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
  }
  if (left.id || right.id) {
    // A missing durable ID cannot adopt another canonical row by sequence alone.
    return Boolean(left.id && right.id && left.id === right.id);
  }
  // A run can publish several durable messages; its ID identifies ownership, not a row.
  return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
}

export type SessionProjectionEntry = {
  message: unknown;
  identity: SessionMessageIdentity | null;
  afterSequence?: number | null;
  live: boolean;
  pending: boolean;
  pendingRunId: string | null;
};

/** Normalize a message into its live, durable, or pending projection entry. */
export function createSessionProjectionEntry(
  message: unknown,
  options?: { envelope?: SessionMessageEnvelope; live?: boolean; pendingRunId?: string | null },
): SessionProjectionEntry {
  const identity = readSessionMessageIdentity(message, options?.envelope);
  const fallback = readRecord(readRecord(message)?.openclawStreamFallback);
  const provisionalFallback = Boolean(
    fallback && identity?.role === "assistant" && !identity.id && identity.sequence === null,
  );
  const inferredPendingRunId =
    options?.live !== true && isLocallyOptimisticSessionMessage(message) ? identity?.runId : null;
  const pendingRunId = normalizeSessionProjectionRunId(
    options?.pendingRunId ?? inferredPendingRunId,
  );
  return {
    message,
    identity,
    afterSequence:
      options?.envelope?.afterSequence !== undefined
        ? options.envelope.afterSequence
        : provisionalFallback && typeof fallback?.afterSequence === "number"
          ? fallback.afterSequence
          : undefined,
    live: options?.live === true || provisionalFallback,
    pending: pendingRunId !== null,
    pendingRunId,
  };
}
