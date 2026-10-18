import type { TranscriptEntryAnchor } from "../../config/sessions/session-accessor.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptMessageAppendResult,
  TranscriptWriteSnapshot,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { normalizeTranscriptJsonValue } from "../../config/sessions/transcript-json.js";
import { isIndexedSessionEntry } from "./session-manager-codec.js";
import type {
  AppendPersistenceOptions,
  SessionEntry,
  SessionMessageEntry,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";

export type PersistRecordResult =
  | undefined
  | {
      anchor?: TranscriptEntryAnchor;
      lifecycleRevision?: string;
      appended: boolean;
      adoptedMessageId?: string;
      effectiveParentId: string | null;
      reloadAfterAppend?: boolean;
    };

export type PersistWorkerRecordResult = {
  result: PersistRecordResult;
  reload?: PreparedSessionTranscriptReload;
  committedVersion: SessionTranscriptContextVersion;
  viewFailure?: Error;
};

export type PersistRecordOptions = AppendPersistenceOptions & {
  /** Retry fence captured from the durable snapshot that passed validation. */
  expectedMutationAt?: number | null;
};

export function transcriptAppendNeedsReload(
  before: SessionTranscriptContextVersion,
  loaded: SessionTranscriptContextVersion | undefined,
): boolean {
  return (
    loaded !== undefined &&
    (before.generation !== loaded.generation || before.rawSeq !== loaded.rawSeq)
  );
}

export function adoptCommittedMessagePayload(
  entry: SessionMessageEntry,
  receipt: TranscriptMessageAppendResult<SessionMessageEntry["message"]>,
  idempotencyLookup: AppendPersistenceOptions["idempotencyLookup"],
): string | null {
  if (receipt.effectiveParentId === undefined) {
    throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
  }
  entry.message = receipt.message;
  if (
    receipt.messageId !== entry.id &&
    !(
      entry.message.role === "user" &&
      "idempotencyKey" in entry.message &&
      typeof entry.message.idempotencyKey === "string" &&
      entry.message.idempotencyKey.length > 0 &&
      idempotencyLookup !== "caller-checked"
    )
  ) {
    throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
  }
  if (idempotencyLookup === "caller-checked" && !receipt.appended) {
    throw new Error(`Session transcript append was not persisted: ${entry.id}`);
  }
  return receipt.effectiveParentId;
}

export function canonicalizeSessionEntry<T extends SessionEntry>(entry: T): T {
  const canonicalEntry = normalizeTranscriptJsonValue(entry, "");
  if (!isIndexedSessionEntry(canonicalEntry) || canonicalEntry.type !== entry.type) {
    throw new Error(`Invalid session transcript entry: ${entry.type}`);
  }
  // SAFETY: Manager-built envelopes retain T's checked discriminant; the codec validates their JSON storage shape.
  return canonicalEntry as T;
}

export function adoptPersistedMessage(
  entry: SessionMessageEntry,
  snapshot: TranscriptWriteSnapshot<
    TranscriptMessageAppendResult<SessionMessageEntry["message"]> | undefined
  >,
  idempotencyLookup: AppendPersistenceOptions["idempotencyLookup"],
  loadedVersion: SessionTranscriptContextVersion | undefined,
): Exclude<PersistRecordResult, undefined> {
  const { result } = snapshot;
  if (!result) {
    throw new Error(`Session transcript message was not persisted: ${entry.id}`);
  }
  const effectiveParentId = adoptCommittedMessagePayload(entry, result, idempotencyLookup);
  if (result.messageId !== entry.id) {
    // A concurrent keyed user is adopted only after reloading its current path.
    if (!result.anchor) {
      throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
    }
    return {
      adoptedMessageId: result.messageId,
      anchor: result.anchor,
      appended: result.appended,
      effectiveParentId,
    };
  }
  const reloadAfterAppend =
    result.appended && transcriptAppendNeedsReload(snapshot.before, loadedVersion);
  return {
    ...(result.anchor ? { anchor: result.anchor } : {}),
    lifecycleRevision: snapshot.lifecycleRevision,
    appended: result.appended,
    effectiveParentId,
    ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
  };
}
