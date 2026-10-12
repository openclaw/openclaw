import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import {
  prepareTranscriptMessageAppendForWorker,
  type PreparedTranscriptMessageAppend,
} from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import type { SessionMetadataWorkerOperations } from "../../config/sessions/session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import {
  captureSessionTranscriptQuestionAnswers,
  resolveSessionTranscriptReadFence,
} from "../../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentMessage } from "../runtime/index.js";
import { getSessionCompactionPersistenceAsync } from "./session-compaction-persistence.js";
import { appendSessionManagerActor } from "./session-manager-actor-append.js";
import {
  withSessionManagerAppend,
  type SessionManagerAppendAdmission,
} from "./session-manager-append-admission.js";
import { SessionManagerNativePersistence } from "./session-manager-native-persistence.js";
import {
  adoptCommittedMessagePayload,
  canonicalizeSessionEntry,
  transcriptAppendNeedsReload,
  type PersistRecordOptions,
  type PersistRecordResult,
  type PersistWorkerRecordResult,
} from "./session-manager-persistence-entry.js";
import {
  committedTranscriptViewError,
  SessionEntryCommittedError,
  SessionManagerActorCommittedError,
  receiveSessionManagerCommit,
} from "./session-manager-persistence-error.js";
import type { SessionEntry, SessionHeader, SessionLeafControl } from "./session-manager-types.js";

export class SessionManagerPersistence extends SessionManagerNativePersistence {
  protected async persistWorkerRecord(
    entry: SessionEntry | SessionLeafControl,
    appendIntent: "active-branch" | undefined,
    writeAdmission: SessionManagerAppendAdmission,
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
    const { options } = writeAdmission;
    const database = "actor" in writeAdmission ? undefined : writeAdmission.database;
    const { env: _env, ...writeTarget } = withOwnedSessionTranscriptWriterFence(target);
    const captured: SessionMetadataWorkerOperations["session.metadata.append"]["input"]["scope"] & {
      storePath: string;
    } = {
      ...writeTarget,
      storePath: database?.path ?? resolveOpenClawAgentSqlitePath(options),
    };
    if (database && "db" in database && database.db.isTransaction) {
      throw new Error("Asynchronous session writes must own their transaction");
    }
    const initialWriter = this.initialTranscriptWriter;
    const admission = resolveSessionTranscriptReadFence(captured);
    const questionAnswers = message?.validateTurn
      ? captureSessionTranscriptQuestionAnswers(
          { path: captured.storePath },
          captured.sessionId,
          admission?.entryId,
        )
      : undefined;
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
      questionAnswers?.assertCurrent();
    };
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
    if ("actor" in writeAdmission) {
      const actor = writeAdmission.actor;
      const header = this.persistenceHeaderPending ? this.fileEntries[0] : undefined;
      if (this.persistenceHeaderPending && header?.type !== "session") {
        throw new Error("Session transcript header was not persisted");
      }
      let loadedVersion = this.transcriptVersion;
      const append = (mutationAt: number | null | undefined) =>
        appendSessionManagerActor({
          actor,
          assertCurrent,
          beforeFreshMessageCommit,
          toolResult: entry.type === "message" && entry.message.role === "toolResult",
          append: {
            kind: "metadata",
            input: {
              scope: captured,
              event: wireEvent,
              ...(wireMessage ? { message: wireMessage } : {}),
              options: {
                ...(appendIntent ? { appendIntent } : {}),
                // The atomic header checks the preimage; this event follows its new watermark.
                ...(!this.persistenceHeaderPending && mutationAt !== undefined
                  ? { expectedMutationAt: mutationAt }
                  : {}),
              },
              view: {
                loadedVersion,
                limits: this.boundedContextLimits,
                admission,
                questionAnswers: questionAnswers?.answers,
              },
            },
            ...(this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)
              ? {
                  initialization: {
                    scope: captured,
                    entry: { sessionId: captured.sessionId, updatedAt: Date.now() },
                    ...(initialWriter && !initialWriter.committedFence
                      ? { initialWriterRunId: initialWriter.writerRunId }
                      : {}),
                  },
                }
              : {}),
            ...(this.persistenceHeaderPending
              ? {
                  header: {
                    scope: captured,
                    event: JSON.stringify(header),
                    options: mutationAt !== undefined ? { expectedMutationAt: mutationAt } : {},
                  },
                }
              : {}),
          },
          onCommitted: (committed) => {
            if (committed.initialEntry?.fence) {
              initialWriter?.recordCommitted(committed.initialEntry.fence);
              Object.assign(target, committed.initialEntry.fence);
              Object.assign(captured, committed.initialEntry.fence);
            }
            const committedHeader = committed.header?.snapshot;
            if (committedHeader?.ok && committedHeader.value.result?.appended) {
              assertBinding();
              this.persistenceHeaderPending = false;
              loadedVersion = committedHeader.value.after;
            }
            // Identity observers may cancel the run; retain its claim and header first.
            const committedIdentity = committed.initialEntry?.identity;
            if (committedIdentity) {
              const databaseIdentity = actor.target.database;
              publishCommittedSessionIdentity(
                captured.agentId,
                databaseIdentity.kind === "file"
                  ? databaseIdentity.physicalIdentity
                  : databaseIdentity.incarnation,
                committedIdentity.previous,
                committedIdentity.current,
              );
              assertCurrent();
            }
          },
        });
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
        const authority = { assertCurrent, authorize: assertCurrent };
        const current = actor.snapshot(authority) ?? (await actor.read(authority));
        outcome = await append(current.transcript.version.updatedAt);
      }
      try {
        if (outcome.committed.kind !== "metadata") {
          throw new Error("Session actor returned another append kind");
        }
        const value = outcome.committed.value;
        const snapshot = value.snapshot;
        if (
          !snapshot.ok ||
          !snapshot.value.result ||
          (entry.type !== "message" && !snapshot.value.result.appended)
        ) {
          throw new Error(`Session transcript entry was not persisted: ${entry.id}`, {
            cause: snapshot.ok ? undefined : snapshot.error,
          });
        }
        const committed = snapshot.value;
        const receipt = snapshot.value.result;
        const effectiveParentId =
          "effectiveParentId" in receipt && receipt.effectiveParentId !== undefined
            ? receipt.effectiveParentId
            : entry.parentId;
        const adoptedMessage = "messageId" in receipt && receipt.messageId !== entry.id;
        const reloadAfterAppend =
          receipt.appended && transcriptAppendNeedsReload(committed.before, loadedVersion);
        if (
          !this.hasNewerPublishedTranscriptView(committed.after) &&
          (adoptedMessage || reloadAfterAppend || effectiveParentId !== entry.parentId) &&
          !value.reload
        ) {
          throw new Error("Session actor omitted the committed transcript reload");
        }
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
        if (value.projectionNeedsReconcile && !outcome.failure) {
          startSessionTranscriptIndexReconcile({
            ...options,
            preferredSessionId: captured.sessionId,
          });
        }
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
          reload: value.reload?.ok ? value.reload.value : undefined,
          committedVersion: committed.after,
          viewFailure:
            outcome.failure ??
            (value.reload?.ok === false
              ? committedTranscriptViewError(value.reload.error)
              : undefined),
        };
      } catch (cause) {
        const failure =
          outcome.failure ??
          new SessionManagerActorCommittedError(
            "session.metadata.append",
            { ok: true, value: outcome.committed.value },
            cause,
          );
        this.invalidateTranscriptView(failure);
        throw failure;
      }
    }
    if (!database) {
      throw new Error("Session append has no database owner");
    }
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
                        questionAnswers: questionAnswers?.answers,
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

  public async persistAsync(
    entry: SessionEntry,
    options?: PersistRecordOptions,
  ): Promise<PersistRecordResult> {
    // Raw callers retain their envelope; only nested immutable payloads are shared.
    const canonical = { ...canonicalizeSessionEntry(entry) };
    return await withSessionManagerAppend(
      this,
      async (admission) => {
        const compactionPersistence = getSessionCompactionPersistenceAsync(this);
        if (!admission && compactionPersistence) {
          throw new Error("Compaction boundary validation failed");
        }
        if (
          !admission ||
          (isIncognitoSessionKey(this.persistenceTarget?.sessionKey) &&
            !("actor" in admission) &&
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
                prepared: prepareTranscriptMessageAppendForWorker({
                  message: canonical.message,
                  config: options?.config,
                }),
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
      },
      canonical.type === "compaction" && Boolean(getSessionCompactionPersistenceAsync(this)),
    );
  }
}
