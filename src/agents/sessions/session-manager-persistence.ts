import type { DatabaseSync } from "node:sqlite";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { requireTranscriptEventAppendSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import {
  prepareTranscriptMessageAppendForWorker,
  type PreparedTranscriptMessageAppend,
} from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionMetadataWorkerOperations } from "../../config/sessions/session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
  withSessionTranscriptWriteAssertion,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import {
  getSessionCompactionPersistence,
  getSessionCompactionPersistenceAsync,
} from "./session-compaction-persistence.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import {
  adoptCommittedMessagePayload,
  canonicalizeSessionEntry,
  adoptPersistedMessage,
  transcriptAppendNeedsReload,
  type PersistRecordOptions,
  type PersistRecordResult,
  type PersistWorkerRecordResult,
} from "./session-manager-persistence-entry.js";
import {
  committedTranscriptViewError,
  SessionEntryCommittedError,
  receiveSessionManagerCommit,
} from "./session-manager-persistence-error.js";
import type { SessionEntry, SessionHeader, SessionLeafControl } from "./session-manager-types.js";
import {
  withSessionManagerWrite,
  type SessionManagerWriteAdmission,
} from "./session-manager-write-admission.js";

export class SessionManagerPersistence extends SessionManagerCore {
  #initialWriter: InitialSessionTranscriptWriter | undefined;
  #navigationEpoch = 0;

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

  protected async persistWorkerRecord(
    entry: SessionEntry | SessionLeafControl,
    appendIntent: "active-branch" | undefined,
    writeAdmission: SessionManagerWriteAdmission,
    message?: Omit<
      NonNullable<SessionMetadataWorkerOperations["session.metadata.append"]["input"]["message"]>,
      "messageJson"
    > & { prepared: PreparedTranscriptMessageAppend<AgentMessage> },
    beforeFreshMessageCommit?: () => void,
    expectedMutationAt?: number | null,
    retryMutationConflicts = true,
    assertNavigation?: () => void,
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
    if ("db" in database && database.db.isTransaction) {
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
      writeAdmission.assertCurrent();
      assertBinding();
      assertNavigation?.();
      initialWriter?.assertActive();
      assertOwned();
    };
    const admission = resolveSessionTranscriptReadFence(captured);
    const persistCompaction = getSessionCompactionPersistenceAsync(this);
    if (entry.type === "compaction" && persistCompaction) {
      if (this.persistenceHeaderPending) {
        throw new Error("Compaction boundary validation failed");
      }
      const committed = await withSessionTranscriptWriteAssertion(identity, assertCurrent, () =>
        persistCompaction({
          scope: identity,
          event: entry,
          ...(appendIntent ? { appendIntent } : {}),
          expectedMutationAt:
            expectedMutationAt !== undefined ? expectedMutationAt : this.transcriptMutationAt,
          ...(initialWriter && !initialWriter.committedFence ? { initializeEntry: true } : {}),
        }),
      ).catch((error: unknown) => {
        if (error instanceof SessionEntryCommittedError) {
          this.invalidateTranscriptView(error);
        }
        throw error;
      });
      try {
        assertCurrent();
        if (initialWriter?.committedFence) {
          Object.assign(target, initialWriter.committedFence);
        }
      } catch (cause) {
        const error = new SessionEntryCommittedError(
          committed.result.id,
          identity,
          committed.after,
          cause,
        );
        this.invalidateTranscriptView(error);
        throw error;
      }
      return {
        result: { appended: true, effectiveParentId: committed.result.parentId },
        committedVersion: committed.after,
      };
    }
    let wireEvent: SessionMetadataWorkerOperations["session.metadata.append"]["input"]["event"];
    if (entry.type === "message") {
      const { message: _message, ...envelope } = entry;
      wireEvent = envelope;
    } else {
      wireEvent = JSON.stringify(entry);
    }
    // Fresh receipts reuse this exact prepared object across the worker handoff.
    if (message) {
      Object.freeze(message.prepared.persistedMessage);
    }
    const wireMessage = message
      ? {
          messageJson: message.prepared.messageJson,
          cwd: message.cwd,
          validateTurn: message.validateTurn,
          idempotencyLookup: message.idempotencyLookup,
        }
      : undefined;
    const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
      () => import("./session-manager-metadata-runtime.js"),
    );
    assertCurrent();
    return await withSessionMetadataWorker(
      options,
      database,
      assertCurrent,
      async (worker) => {
        if (this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)) {
          const initialization = await receiveSessionManagerCommit(
            "session.metadata.initialize",
            () =>
              worker.execute({
                type: "session.metadata.initialize",
                input: {
                  scope: captured,
                  entry: { sessionId: captured.sessionId, updatedAt: Date.now() },
                  ...(initialWriter && !initialWriter.committedFence
                    ? { initialWriterRunId: initialWriter.writerRunId }
                    : {}),
                },
              }),
          );
          const committed = initialization.value;
          try {
            if (committed.fence) {
              if (!("db" in database)) {
                initialWriter?.recordCommitted(committed.fence);
              }
              Object.assign(target, committed.fence);
              Object.assign(captured, committed.fence);
            }
          } finally {
            if (committed.identity && !("db" in database)) {
              publishCommittedSessionIdentity(
                captured.agentId,
                database.identity.incarnation,
                committed.identity.previous,
                committed.identity.current,
              );
            }
          }
          if (initialization.failure) {
            this.invalidateTranscriptView(initialization.failure);
            throw initialization.failure;
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
          event: SessionHeader | SessionEntry | SessionLeafControl,
          bytes: SessionMetadataWorkerOperations["session.metadata.append"]["input"]["event"],
          mutationAt: number | null | undefined,
          intent?: "active-branch",
        ) => {
          const receipt = await receiveSessionManagerCommit("session.metadata.append", () =>
            worker.execute({
              type: "session.metadata.append",
              input: {
                scope: captured,
                event: bytes,
                ...(event.type === "message" ? { message: wireMessage } : {}),
                options: {
                  ...(intent ? { appendIntent: intent } : {}),
                  ...(mutationAt !== undefined ? { expectedMutationAt: mutationAt } : {}),
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
            }),
          );
          const result = receipt.value;
          if (result.projectionNeedsReconcile && !receipt.failure) {
            startSessionTranscriptIndexReconcile({
              ...options,
              preferredSessionId: captured.sessionId,
            });
          }
          return { ...result, failure: receipt.failure };
        };
        let loadedVersion = this.transcriptVersion;
        const append = async (initialMutationAt: number | null | undefined) => {
          let mutationAt = initialMutationAt;
          if (this.persistenceHeaderPending) {
            const header = this.fileEntries[0];
            if (!header || header.type !== "session") {
              throw new Error("Session transcript header was not persisted");
            }
            const headerReceipt = await appendEvent(header, JSON.stringify(header), mutationAt);
            const headerSnapshot = headerReceipt.snapshot;
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
            if (headerReceipt.failure) {
              this.invalidateTranscriptView(headerReceipt.failure);
              throw headerReceipt.failure;
            }
            mutationAt = this.transcriptMutationAt;
          }
          loadedVersion = this.transcriptVersion;
          const outcome = await appendEvent(entry, wireEvent, mutationAt, appendIntent);
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
            failure: outcome.failure,
          };
        };
        let outcome;
        try {
          outcome = await append(
            expectedMutationAt !== undefined ? expectedMutationAt : this.transcriptMutationAt,
          );
        } catch (error) {
          if (
            !retryMutationConflicts ||
            expectedMutationAt !== undefined ||
            !(error instanceof SqliteTranscriptMutationConflictError)
          ) {
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
          if (!("messageId" in receipt) || !message) {
            throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
          }
          adoptCommittedMessagePayload(
            entry,
            { ...receipt, message: receipt.message ?? message.prepared.persistedMessage },
            message.idempotencyLookup,
          );
        }
        const effectiveParentId =
          "effectiveParentId" in receipt && receipt.effectiveParentId !== undefined
            ? receipt.effectiveParentId
            : entry.parentId;
        const reloadAfterAppend =
          receipt.appended && transcriptAppendNeedsReload(committed.before, loadedVersion);
        return {
          result: {
            appended: receipt.appended,
            ...("anchor" in receipt && receipt.anchor ? { anchor: receipt.anchor } : {}),
            lifecycleRevision: committed.lifecycleRevision,
            effectiveParentId,
            ...("messageId" in receipt && receipt.messageId !== entry.id
              ? { adoptedMessageId: receipt.messageId }
              : {}),
            ...(reloadAfterAppend ? { reloadAfterAppend: true } : {}),
          },
          reload: reload?.ok ? reload.value : undefined,
          committedVersion: committed.after,
          viewFailure:
            outcome.failure ??
            (reload?.ok === false ? committedTranscriptViewError(reload.error) : undefined),
        };
      },
      { beforeFreshMessageCommit, initialWriter },
    );
  }

  /** @deprecated Await persistAsync. This method will be removed in the next Plugin SDK major. */
  public persist(entry: SessionEntry, options?: PersistRecordOptions): PersistRecordResult {
    prepareSessionManagerSync("persist", this.persistenceTarget, this);
    return this.persistRecord(entry, options);
  }

  public async persistAsync(
    entry: SessionEntry,
    options?: PersistRecordOptions,
  ): Promise<PersistRecordResult> {
    // Raw callers retain their envelope; only nested immutable payloads are shared.
    const canonical = { ...canonicalizeSessionEntry(entry, options) };
    return await withSessionManagerWrite(this, async (admission) => {
      const compactionPersistence = getSessionCompactionPersistenceAsync(this);
      if (!admission && compactionPersistence) {
        throw new Error("Compaction boundary validation failed");
      }
      if (
        !admission ||
        (isIncognitoSessionKey(this.persistenceTarget?.sessionKey) &&
          "db" in admission.database &&
          !(canonical.type === "compaction" && compactionPersistence))
      ) {
        return this.persistRecord(canonical, options);
      }
      const target = this.getSessionTarget();
      if (!target) {
        throw new Error("Session writer worker requires a persistent session");
      }
      const capturedTarget = captureSessionTranscriptTargetBinding(target);
      const sessionId = this.getSessionId();
      const assertOwned = captureOwnedTranscriptWriteAssertion(capturedTarget);
      assertOwned();
      const message =
        canonical.type === "message"
          ? {
              prepared: prepareTranscriptMessageAppendForWorker(
                copyCodeModeSourceAppendOptions(options, {
                  message: canonical.message,
                  config: options?.config,
                }),
              ),
              cwd: this.cwd,
              validateTurn: false,
              idempotencyLookup: options?.idempotencyLookup,
            }
          : undefined;
      const committed = await this.persistWorkerRecord(
        canonical,
        options?.appendIntent,
        admission,
        message,
        options?.beforeFreshMessageCommit,
        options?.expectedMutationAt,
        false,
      );
      try {
        if (
          this.getSessionId() !== sessionId ||
          !sameSessionTranscriptTargetBinding(capturedTarget, this.getSessionTarget())
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        assertOwned();
        if (committed.viewFailure) {
          throw committed.viewFailure;
        }
        if (!this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
          this.transcriptVersion = committed.committedVersion;
          this.transcriptMutationAt = committed.committedVersion.updatedAt;
        }
      } catch (cause) {
        if (committed.result?.appended === false) {
          throw cause;
        }
        const error = new SessionEntryCommittedError(
          committed.result?.adoptedMessageId ?? canonical.id,
          capturedTarget,
          committed.committedVersion,
          cause,
        );
        this.invalidateTranscriptView(error);
        throw error;
      }
      return canonical.type !== "message" &&
        !(canonical.type === "compaction" && compactionPersistence) &&
        !committed.result?.reloadAfterAppend &&
        committed.result?.effectiveParentId === canonical.parentId
        ? undefined
        : committed.result;
    });
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
