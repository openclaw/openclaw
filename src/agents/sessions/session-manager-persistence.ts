import {
  ensureSessionEntrySync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { requireTranscriptEventAppendSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { copyPreparedModelVisibleToolText } from "../../logging/redact-internal.js";
import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  copyCodeModeSourceAppend,
  copyCodeModeSourceAppendOptions,
  getCodeModeSourceAppend,
} from "../transcript-code-mode-source.js";
import { getSessionCompactionPersistence } from "./session-compaction-persistence.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata.worker.js";
import type {
  AppendPersistenceOptions,
  ModelChangeEntry,
  SessionEntry,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";
import type { SessionManagerWriteAdmission } from "./session-manager-write-admission.js";

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

type PersistRecordOptions = AppendPersistenceOptions & {
  /** Retry fence captured from the durable snapshot that passed validation. */
  expectedMutationAt?: number | null;
};

export function canonicalizeSessionEntry<T extends SessionEntry>(
  entry: T,
  options?: AppendPersistenceOptions,
): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Match the persisted JSON/toJSON shape exactly.
  const canonicalEntry: unknown = JSON.parse(JSON.stringify(entry));
  if (!isIndexedSessionEntry(canonicalEntry) || canonicalEntry.type !== entry.type) {
    throw new Error(`Invalid session transcript entry: ${entry.type}`);
  }
  if (entry.type === "message" && canonicalEntry.type === "message") {
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
      getCodeModeSourceAppend(options),
      (source) => source,
    );
  }
  // SAFETY: Manager-built envelopes retain T's checked discriminant; the codec validates their JSON storage shape.
  return canonicalEntry as T;
}

export function isSqliteTranscriptMutationConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (current.name === "SqliteTranscriptMutationConflictError") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export class SessionManagerPersistence extends SessionManagerCore {
  #initialWriter: InitialSessionTranscriptWriter | undefined;

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

  protected async persistWorkerRecord(
    entry: ModelChangeEntry | ThinkingLevelChangeEntry | SessionMessageEntry,
    appendIntent: "active-branch" | undefined,
    writeAdmission: SessionManagerWriteAdmission,
    message?: NonNullable<
      SessionMetadataWorkerOperations["session.metadata.append"]["input"]["message"]
    >,
  ): Promise<PersistWorkerRecordResult> {
    this.assertTranscriptWriteActive();
    const target = this.persistenceTarget;
    if (!target) {
      throw new Error("Session writer worker requires a persistent session");
    }
    const identity = { ...target };
    const sessionId = this.getSessionId();
    const { database, options } = writeAdmission;
    const { env: _env, ...writeTarget } = withOwnedSessionTranscriptWriterFence(target);
    const captured: SessionMetadataWorkerOperations["session.metadata.append"]["input"]["scope"] = {
      ...writeTarget,
      storePath: database.path,
    };
    if (database.db.isTransaction) {
      throw new Error("Asynchronous session writes must own their transaction");
    }
    const initialWriter = this.#initialWriter;
    const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
    const assertBinding = () => {
      const current = this.persistenceTarget;
      if (
        this.getSessionId() !== sessionId ||
        !sameSessionTranscriptTargetBinding(identity, current)
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
    };
    const assertCurrent = () => {
      assertBinding();
      initialWriter?.assertActive();
      assertOwned();
    };
    const admission = resolveSessionTranscriptReadFence(captured);
    const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
      () => import("./session-manager-metadata-runtime.js"),
    );
    assertCurrent();
    return await withSessionMetadataWorker(options, database, assertCurrent, async (worker) => {
      if (this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)) {
        const committed = await worker.execute({
          type: "session.metadata.initialize",
          input: {
            scope: captured,
            entry: { sessionId: captured.sessionId, updatedAt: Date.now() },
            ...(initialWriter && !initialWriter.committedFence
              ? { initialWriterRunId: initialWriter.writerRunId }
              : {}),
          },
        });
        try {
          if (committed.fence) {
            initialWriter?.recordCommitted(committed.fence);
            Object.assign(target, committed.fence);
            Object.assign(captured, committed.fence);
          }
        } finally {
          if (committed.identity) {
            publishCommittedSessionIdentity(
              captured.agentId,
              committed.identity.previous,
              committed.identity.current,
            );
          }
        }
        if (!committed.owned) {
          if (captured.expectedWriterRunId !== undefined) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          throw new Error("Session transcript header was not persisted");
        }
        assertCurrent();
      }
      const appendEvent = async (
        event: Parameters<typeof worker.execute<"session.metadata.append">>[0]["input"]["event"],
        expectedMutationAt: number | null | undefined,
        intent?: "active-branch",
      ) => {
        const result = await worker.execute({
          type: "session.metadata.append",
          input: {
            scope: captured,
            event,
            ...(event.type === "message" ? { message } : {}),
            options: {
              ...(intent ? { appendIntent: intent } : {}),
              ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
            },
            ...(event.type !== "session"
              ? {
                  view: {
                    loadedVersion: this.transcriptVersion,
                    limits: this.boundedContextLimits,
                    admission,
                  },
                }
              : {}),
          },
        });
        if (result.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...options,
            preferredSessionId: captured.sessionId,
          });
        }
        return result;
      };
      let loadedVersion = this.transcriptVersion;
      const append = async (expectedMutationAt: number | null | undefined) => {
        let mutationAt = expectedMutationAt;
        if (this.persistenceHeaderPending) {
          const header = this.fileEntries[0];
          if (!header || header.type !== "session") {
            throw new Error("Session transcript header was not persisted");
          }
          const headerSnapshot = (await appendEvent(header, mutationAt)).snapshot;
          if (!headerSnapshot.ok || !headerSnapshot.value.result?.appended) {
            throw new Error("Session transcript header was not persisted", {
              cause: headerSnapshot.ok ? undefined : headerSnapshot.error,
            });
          }
          const committed = headerSnapshot.value;
          assertBinding();
          if (!this.hasNewerPublishedTranscriptView(committed.after)) {
            this.transcriptVersion = committed.after;
            this.transcriptMutationAt = committed.after.updatedAt;
          }
          this.persistenceHeaderPending = false;
          mutationAt = this.transcriptMutationAt;
        }
        loadedVersion = this.transcriptVersion;
        const outcome = await appendEvent(entry, mutationAt, appendIntent);
        const snapshot = outcome.snapshot;
        if (
          !snapshot.ok ||
          !snapshot.value.result ||
          (entry.type !== "message" && !snapshot.value.result.appended)
        ) {
          throw new Error(`Session transcript entry was not persisted: ${entry.id}`, {
            cause: snapshot.ok ? undefined : snapshot.error,
          });
        }
        return {
          committed: { ...snapshot.value, result: snapshot.value.result },
          reload: outcome.reload,
        };
      };
      let outcome;
      try {
        outcome = await append(this.transcriptMutationAt);
      } catch (error) {
        if (!isSqliteTranscriptMutationConflict(error)) {
          throw error;
        }
        const fresh = await worker.execute({
          type: "session.metadata.mutation",
          input: { scope: captured },
        });
        outcome = await append(fresh);
      }
      const { committed, reload } = outcome;
      const receipt = committed.result;
      if (entry.type === "message") {
        if (
          !("messageId" in receipt) ||
          receipt.messageId !== entry.id ||
          receipt.effectiveParentId === undefined
        ) {
          throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
        }
        entry.message = receipt.message;
        if (message?.idempotencyLookup === "caller-checked" && !receipt.appended) {
          throw new Error(`Session transcript append was not persisted: ${entry.id}`);
        }
      }
      const effectiveParentId =
        "effectiveParentId" in receipt && receipt.effectiveParentId !== undefined
          ? receipt.effectiveParentId
          : entry.parentId;
      const reloadAfterAppend =
        receipt.appended &&
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
      let viewFailure: Error | undefined;
      if (reload?.ok === false) {
        const error = new Error("Committed session transcript view could not be reconstructed");
        if (reload.error) {
          retainOpenClawStateWorkerErrorPayload(error, reload.error);
        }
        viewFailure = hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
      }
      return {
        result: {
          appended: receipt.appended,
          ...("anchor" in receipt && receipt.anchor ? { anchor: receipt.anchor } : {}),
          lifecycleRevision: committed.lifecycleRevision,
          effectiveParentId,
          ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
        },
        reload: reload?.ok ? reload.value : undefined,
        committedVersion: committed.after,
        viewFailure,
      };
    });
  }

  protected persistRecord(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
  ): PersistRecordResult {
    if (this.persistenceTarget) {
      return this.persistSqliteRecord(entry, options, preparedMessage);
    }
    if (getSessionCompactionPersistence(this)) {
      throw new Error("Compaction boundary validation failed");
    }
    return undefined;
  }

  public persist(entry: SessionEntry, options?: PersistRecordOptions): PersistRecordResult {
    return this.persistRecord(entry, options);
  }

  private persistSqliteRecord(
    entry: unknown,
    options?: PersistRecordOptions,
    preparedMessage?: PreparedTranscriptMessageAppend<AgentMessage>,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      return undefined;
    }
    this.assertTranscriptWriteActive();
    const scope = this.persistenceTarget;
    const initialWriter = this.#initialWriter;
    const persistCompaction = getSessionCompactionPersistence(this);
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
      const reloadAfterAppend =
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
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
      this.transcriptVersion = requireTranscriptEventAppendSnapshot(
        appendTranscriptEventSnapshotSync(
          scope,
          header,
          options?.expectedMutationAt !== undefined
            ? { expectedMutationAt: options.expectedMutationAt }
            : this.transcriptMutationAt !== undefined
              ? { expectedMutationAt: this.transcriptMutationAt }
              : {},
        ),
        "Session transcript header was not persisted",
      ).after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      this.persistenceHeaderPending = false;
    }
    const expectedMutationAt = persistedHeader
      ? this.transcriptMutationAt
      : options?.expectedMutationAt !== undefined
        ? options.expectedMutationAt
        : this.transcriptMutationAt;
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      this.transcriptVersion = requireTranscriptEventAppendSnapshot(
        appendTranscriptEventSnapshotSync(
          scope,
          entry,
          expectedMutationAt !== undefined ? { expectedMutationAt } : {},
        ),
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      ).after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      const loadedVersion = this.transcriptVersion;
      const outcome = appendTranscriptEventSnapshotSync(scope, entry, {
        ...(options?.appendIntent === "active-branch"
          ? { appendIntent: options.appendIntent }
          : {}),
        ...(expectedMutationAt !== undefined ? { expectedMutationAt } : {}),
      });
      const committed = requireTranscriptEventAppendSnapshot(
        outcome,
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      const effectiveParentId =
        committed.result.effectiveParentId !== undefined
          ? committed.result.effectiveParentId
          : entry.parentId;
      this.transcriptVersion = committed.after;
      this.transcriptMutationAt = this.transcriptVersion.updatedAt;
      const reloadAfterAppend =
        loadedVersion !== undefined &&
        (committed.before.generation !== loadedVersion.generation ||
          committed.before.rawSeq !== loadedVersion.rawSeq);
      return effectiveParentId === entry.parentId && !reloadAfterAppend
        ? undefined
        : {
            appended: true,
            effectiveParentId,
            ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
          };
    }
    const appendOptions = copyCodeModeSourceAppendOptions(options, {
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
    } satisfies Parameters<typeof appendTranscriptMessageSnapshotSync>[1]);
    const loadedVersion = this.transcriptVersion;
    const outcome = appendTranscriptMessageSnapshotSync(scope, appendOptions, preparedMessage);
    if (!outcome.ok) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`, {
        cause: outcome.error,
      });
    }
    const result = outcome.value.result;
    this.transcriptVersion = outcome.value.after;
    if (!result) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`);
    }
    if (result.appended) {
      this.transcriptMutationAt = outcome.value.after.updatedAt;
    }
    // Carry the canonical storage bytes even when adopting a context-excluded row.
    entry.message = result.message;
    if (result.messageId !== entry.id) {
      const idempotencyKey =
        entry.message.role === "user" &&
        "idempotencyKey" in entry.message &&
        typeof entry.message.idempotencyKey === "string" &&
        entry.message.idempotencyKey.length > 0
          ? entry.message.idempotencyKey
          : undefined;
      if (idempotencyKey && options?.idempotencyLookup !== "caller-checked") {
        // Ingress can commit the keyed user after this manager loaded. The
        // caller reloads and adopts only when that canonical row is still active.
        if (!result.anchor) {
          throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
        }
        return {
          adoptedMessageId: result.messageId,
          anchor: result.anchor,
          appended: result.appended,
          effectiveParentId: result.effectiveParentId ?? null,
        };
      }
      throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
    }
    if (
      options?.idempotencyLookup === "caller-checked" &&
      (!result?.appended || result.messageId !== entry.id)
    ) {
      throw new Error(`Session transcript append was not persisted: ${entry.id}`);
    }
    if (result.effectiveParentId === undefined) {
      throw new Error(`Session transcript append parent was not returned: ${entry.id}`);
    }
    const reloadAfterAppend =
      result.appended &&
      loadedVersion !== undefined &&
      (outcome.value.before.generation !== loadedVersion.generation ||
        outcome.value.before.rawSeq !== loadedVersion.rawSeq);
    return {
      ...(result.anchor ? { anchor: result.anchor } : {}),
      lifecycleRevision: outcome.value.lifecycleRevision,
      appended: result.appended,
      effectiveParentId: result.effectiveParentId,
      ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
    };
  }
}
