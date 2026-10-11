import type { DatabaseSync } from "node:sqlite";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { requireTranscriptEventAppendSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import type { AgentMessage } from "../runtime/index.js";
import { getSessionCompactionPersistence } from "./session-compaction-persistence.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import {
  adoptPersistedMessage,
  transcriptAppendNeedsReload,
  type PersistRecordOptions,
  type PersistRecordResult,
} from "./session-manager-persistence-entry.js";
import type { SessionEntry } from "./session-manager-types.js";

/** Released synchronous SDK methods keep their native transaction and publication contract. */
export class SessionManagerNativePersistence extends SessionManagerCore {
  #initialWriter: InitialSessionTranscriptWriter | undefined;
  #navigationEpoch = 0;

  protected get initialTranscriptWriter(): InitialSessionTranscriptWriter | undefined {
    return this.#initialWriter;
  }

  protected recordTranscriptNavigationChange(): void {
    this.#navigationEpoch++;
    this.cacheTtlProjectionPrefixes = this.cacheTtlProjectionPrefixes?.filter(
      (prefix) => prefix.anchorIds.length > 0,
    );
  }

  /** Local branch selections revoke pending writes; committed view adoption does not. */
  protected captureTranscriptNavigationAssertion(): () => void {
    const epoch = this.#navigationEpoch;
    return () => {
      if (this.#navigationEpoch !== epoch) {
        throw new Error("Session transcript navigation changed before publication");
      }
    };
  }

  protected retainTranscriptWriter(): void {
    const sessionTarget = this.persistenceTarget;
    if (sessionTarget && getOwnedSessionTranscriptWriterFence({ sessionTarget })) {
      this.#initialWriter ??= getOwnedSessionTranscriptInitialWriter({ sessionTarget });
    }
  }

  protected assertTranscriptWriteActive(): void {
    this.assertTranscriptViewAvailable();
    if (!this.persistenceTarget) {
      return;
    }
    const scope = this.persistenceTarget;
    const inheritedWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
    this.#initialWriter ??= inheritedWriter;
    const initialWriter = this.#initialWriter;
    if (!initialWriter) {
      return;
    }
    initialWriter.assertActive();
    if (!initialWriter.committedFence && inheritedWriter !== initialWriter) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    Object.assign(
      scope,
      initialWriter.committedFence ?? {
        expectedLifecycleRevision: undefined,
        expectedWriterRunId: initialWriter.writerRunId,
      },
    );
  }

  protected hasNewerPublishedTranscriptView(version: SessionTranscriptContextVersion): boolean {
    this.assertTranscriptViewAvailable();
    // Appends and rewrites strictly advance this owner-held watermark, including maintenance.
    return (
      this.transcriptMutationAt != null &&
      version.updatedAt !== null &&
      this.transcriptMutationAt >= version.updatedAt
    );
  }

  /** @deprecated Await persistAsync. Removal: next Plugin SDK major. */
  public persist(entry: SessionEntry, options?: PersistRecordOptions): PersistRecordResult {
    prepareSessionManagerSync("persist", this.persistenceTarget, this);
    return this.persistRecord(entry, options);
  }

  protected persistRecord(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      if (getSessionCompactionPersistence(this)) {
        throw new Error("Compaction boundary validation failed");
      }
      return undefined;
    }
    this.assertTranscriptWriteActive();
    const scope = this.persistenceTarget;
    const initialWriter = this.#initialWriter;
    const persistCompaction = getSessionCompactionPersistence(this);
    const sessionId = this.sessionId;
    const isCurrentView = () =>
      this.sessionId === sessionId &&
      sameSessionTranscriptTargetBinding(scope, this.persistenceTarget);
    const onPendingTransaction = (database: DatabaseSync) => {
      if (!isCurrentView()) {
        return;
      }
      const previous = this.captureTranscriptView(true);
      stageSqliteTransactionState(database, {
        stage: () => {},
        commit: () => {},
        rollback: () => {
          if (isCurrentView()) {
            Object.assign(this, previous);
          }
        },
      });
    };
    const viewGuard = {
      assertCurrent: () => {
        this.assertTranscriptViewAvailable();
        if (!isCurrentView()) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
      onPendingTransaction,
    };
    const appendEvent = (
      event: unknown,
      appendOptions: Parameters<typeof appendTranscriptEventSnapshotSync>[2],
      errorMessage: string,
    ) => {
      const committed = requireTranscriptEventAppendSnapshot(
        appendTranscriptEventSnapshotSync(scope, event, appendOptions, undefined, viewGuard),
        errorMessage,
      );
      this.transcriptVersion = committed.after;
      this.transcriptMutationAt = committed.after.updatedAt;
      return committed;
    };
    if (persistCompaction && isIndexedSessionEntry(entry) && entry.type === "compaction") {
      // Atomic accounting accepts exactly one boundary, never lazy transcript initialization.
      if (this.persistenceHeaderPending) {
        throw new Error("Compaction boundary validation failed");
      }
      const loadedVersion = this.transcriptVersion;
      const expectedMutationAt =
        options?.expectedMutationAt !== undefined
          ? options.expectedMutationAt
          : this.transcriptMutationAt;
      const committed = persistCompaction({
        scope: { ...scope },
        event: entry,
        ...(options?.appendIntent ? { appendIntent: options.appendIntent } : {}),
        ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
        ...(initialWriter && !initialWriter.committedFence ? { initializeEntry: true } : {}),
      });
      if (initialWriter?.committedFence) {
        Object.assign(scope, initialWriter.committedFence);
      }
      this.transcriptVersion = committed.after;
      this.transcriptMutationAt = committed.after.updatedAt;
      const reloadAfterAppend = transcriptAppendNeedsReload(committed.before, loadedVersion);
      return {
        appended: true,
        effectiveParentId: committed.result.parentId,
        ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
      };
    }
    if (this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)) {
      if (
        !ensureSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
        })
      ) {
        throw new Error("Session transcript header was not persisted");
      }
      initialWriter?.assertActive();
      if (initialWriter?.committedFence) {
        Object.assign(scope, initialWriter.committedFence);
      }
    }
    const persistedHeader = this.persistenceHeaderPending;
    if (persistedHeader) {
      const header = this.fileEntries[0];
      if (!header || header.type !== "session") {
        throw new Error("Session transcript header was not persisted");
      }
      appendEvent(
        header,
        options?.expectedMutationAt !== undefined
          ? { expectedMutationAt: options.expectedMutationAt }
          : this.transcriptMutationAt !== undefined
            ? { expectedMutationAt: this.transcriptMutationAt }
            : {},
        "Session transcript header was not persisted",
      );
      this.persistenceHeaderPending = false;
    }
    const expectedMutationAt = persistedHeader
      ? this.transcriptMutationAt
      : options?.expectedMutationAt !== undefined
        ? options.expectedMutationAt
        : this.transcriptMutationAt;
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      appendEvent(
        entry,
        expectedMutationAt !== undefined ? { expectedMutationAt } : {},
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      );
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      const loadedVersion = this.transcriptVersion;
      const committed = appendEvent(
        entry,
        {
          ...(options?.appendIntent === "active-branch"
            ? { appendIntent: options.appendIntent }
            : {}),
          ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
        },
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      const effectiveParentId =
        committed.result.effectiveParentId !== undefined
          ? committed.result.effectiveParentId
          : entry.parentId;
      const reloadAfterAppend = transcriptAppendNeedsReload(committed.before, loadedVersion);
      return effectiveParentId === entry.parentId && !reloadAfterAppend
        ? undefined
        : {
            appended: true,
            effectiveParentId,
            ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
          };
    }
    const appendOptions = {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.beforeFreshMessageCommit
        ? { beforeFreshMessageCommit: options.beforeFreshMessageCommit }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
      ...(options?.appendIntent === "active-branch" ? { appendIntent: options.appendIntent } : {}),
    } satisfies Parameters<typeof appendTranscriptMessageSnapshotSync>[1];
    const loadedVersion = this.transcriptVersion;
    const outcome = appendTranscriptMessageSnapshotSync(
      scope,
      appendOptions,
      preparedMessage,
      undefined,
      viewGuard,
    );
    if (!outcome.ok) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`, {
        cause: outcome.error,
      });
    }
    this.transcriptVersion = outcome.value.after;
    if (outcome.value.result?.appended) {
      this.transcriptMutationAt = outcome.value.after.updatedAt;
    }
    return adoptPersistedMessage(entry, outcome.value, options?.idempotencyLookup, loadedVersion);
  }
}
