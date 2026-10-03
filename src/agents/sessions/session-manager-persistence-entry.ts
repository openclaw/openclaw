import type { TranscriptEntryAnchor } from "../../config/sessions/session-accessor.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptMessageAppendResult,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { normalizeTranscriptJsonValue } from "../../config/sessions/transcript-json.js";
import { copyPreparedModelVisibleToolText } from "../../logging/redact-internal.js";
import {
  copyCodeModeSourceAppend,
  getCodeModeSourceAppend,
} from "../transcript-code-mode-source.js";
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

export function canonicalizeSessionEntry<T extends SessionEntry>(
  entry: T,
  options?: AppendPersistenceOptions,
): T {
  const sourceAppend = getCodeModeSourceAppend(options);
  const canonicalEntry = normalizeTranscriptJsonValue(entry, "", Boolean(sourceAppend));
  if (!isIndexedSessionEntry(canonicalEntry) || canonicalEntry.type !== entry.type) {
    throw new Error(`Invalid session transcript entry: ${entry.type}`);
  }
  if (entry !== canonicalEntry && entry.type === "message" && canonicalEntry.type === "message") {
    if (
      entry.message.role === "toolResult" &&
      canonicalEntry.message.role === "toolResult" &&
      Array.isArray(entry.message.content) &&
      Array.isArray(canonicalEntry.message.content)
    ) {
      const canonicalContent = canonicalEntry.message.content;
      entry.message.content.forEach((block, index) => {
        const canonicalBlock = canonicalContent[index];
        if (block?.type === "text" && canonicalBlock?.type === "text") {
          copyPreparedModelVisibleToolText(block, canonicalBlock);
        }
      });
    }
    copyCodeModeSourceAppend(
      entry.message,
      canonicalEntry.message,
      sourceAppend,
      (source) => source,
    );
  }
  // SAFETY: Manager-built envelopes retain T's checked discriminant; the codec validates their JSON storage shape.
  return canonicalEntry as T;
}
