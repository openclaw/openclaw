import {
  readActiveTranscriptEntryAnchor,
  readTranscriptMutationAtSync,
  validatePreparedAssistantAppendSync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import {
  prepareTranscriptMessageAppend,
  prepareTranscriptMessageAppendForWorker,
} from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { transcriptEventContextEligibility } from "../../config/sessions/session-transcript-projection-append.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { Message } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { getSessionCompactionPersistenceAsync } from "./session-compaction-persistence.js";
import { withSessionManagerAppend } from "./session-manager-append-admission.js";
import { isTalkRealtimeVoiceEntry } from "./session-manager-codec.js";
import {
  prepareCurrentTurnReplaySelection,
  resolveCurrentTurnEntryId,
  sessionManagerPrepareCurrentTurnReplay,
} from "./session-manager-current-turn.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { prepareSessionManagerSync } from "./session-manager-incognito-scope.js";
import { sessionManagerReadMessageAnchor } from "./session-manager-message-anchor.js";
import {
  canonicalizeSessionEntry,
  type PersistRecordResult,
  type PersistWorkerRecordResult,
} from "./session-manager-persistence-entry.js";
import { SessionManagerActorCommittedError } from "./session-manager-persistence-error.js";
import { SessionManagerSuffixPersistence } from "./session-manager-suffix-persistence.js";
import type {
  AppendPersistenceOptions,
  SessionEntry,
  SessionMessageEntry,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";

export class SessionManagerAppend extends SessionManagerSuffixPersistence {
  #lastMessageAppend:
    | {
        anchor: TranscriptEntryAnchor;
        target: ReturnType<SessionManagerAppend["getSessionTarget"]>;
      }
    | undefined;

  [sessionManagerReadMessageAnchor](entryId: string | null | undefined) {
    this.assertTranscriptViewAvailable();
    const receipt = this.#lastMessageAppend;
    return receipt &&
      receipt.anchor.entryId === entryId &&
      receipt.anchor.generation === this.transcriptVersion?.generation &&
      this.byId.has(receipt.anchor.entryId) &&
      sameSessionTranscriptTargetBinding(receipt.target, this.persistenceTarget)
      ? receipt.anchor
      : undefined;
  }

  protected appendEntryAsync<T extends SessionEntry>(
    entry: T,
    options?: AppendPersistenceOptions,
    preserveParent = false,
  ): Promise<{
    entry: T;
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
    viewWasSuperseded?: true;
  }> {
    const canonical = canonicalizeSessionEntry(entry, options);
    return withSessionManagerAppend(
      this,
      async (admission) => {
        this.assertTranscriptWriteActive();
        if (canonical.type === "label" && !this.byId.has(canonical.targetId)) {
          throw new Error(`Entry ${canonical.targetId} not found`);
        }
        if (!preserveParent) {
          canonical.parentId = this.appendParentId;
        }
        const persistCompaction = getSessionCompactionPersistenceAsync(this);
        if (!admission && persistCompaction) {
          throw new Error("Compaction boundary validation failed");
        }
        if (
          !admission ||
          (isIncognitoSessionKey(this.persistenceTarget?.sessionKey) &&
            !("actor" in admission) &&
            "db" in admission.database &&
            !(canonical.type === "compaction" && persistCompaction))
        ) {
          // Incognito retains its host-owned store until actor activation; detached views do not write.
          if (canonical.type === "message") {
            const result = this.appendMessageWithTranscriptAnchorSync(canonical.message, options);
            canonical.id = result.entryId;
            canonical.message = result.message;
            canonical.parentId = this.byId.get(result.entryId)?.parentId ?? canonical.parentId;
            return { ...result, entry: canonical };
          }
          return this.appendEntry(canonical, options, preserveParent);
        }
        const activeBranchAppend =
          !preserveParent &&
          !this.pendingDeliberateAppend &&
          this.appendMode !== "side" &&
          !isSessionTranscriptSideAppendEntry(canonical);
        const admittedUserId = this.persistenceTarget
          ? resolveSessionTranscriptReadFence(this.persistenceTarget)?.entryId
          : undefined;
        const target = this.getSessionTarget();
        const sessionId = this.getSessionId();
        const assertNavigation = this.captureTranscriptNavigationAssertion();
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
                validateTurn:
                  activeBranchAppend &&
                  (canonical.message.role === "assistant" ||
                    canonical.message.role === "toolResult" ||
                    readNestedToolActivity(canonical.message) !== undefined),
                idempotencyLookup: options?.idempotencyLookup,
              }
            : undefined;
        if (canonical.type === "message" && message) {
          canonical.message = message.prepared.persistedMessage;
        }
        const committed = await this.persistWorkerRecord(
          canonical,
          activeBranchAppend ? "active-branch" : undefined,
          admission,
          message,
          options?.beforeFreshMessageCommit,
          undefined,
          !activeBranchAppend ||
            canonical.type !== "message" ||
            canonical.message.role === "user" ||
            message?.validateTurn === true,
          assertNavigation,
        );
        try {
          this.assertTranscriptWriteActive();
          if (
            this.getSessionId() !== sessionId ||
            !sameSessionTranscriptTargetBinding(target, this.getSessionTarget())
          ) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          // A newer committed view owns navigation; this receipt will not replace it.
          if (!this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
            assertNavigation();
          }
          return this.adoptWorkerCommittedEntry(canonical, committed, admittedUserId);
        } catch (cause) {
          if (committed.result?.appended === false) {
            // A replay refusal has no newly committed transcript row to recover.
            throw cause;
          }
          const error = new Error(
            "Session entry committed, but its view could not be adopted; do not replay the append",
            { cause },
          );
          error.name =
            canonical.type === "message"
              ? "SessionMessageCommittedError"
              : "SessionEntryCommittedError";
          recordModelFallbackStop(error);
          this.invalidateTranscriptView(error);
          throw error;
        }
      },
      canonical.type === "compaction" && Boolean(getSessionCompactionPersistenceAsync(this)),
    );
  }
  protected appendEntry<T extends SessionEntry>(
    entry: T,
    options?: AppendPersistenceOptions,
    preserveParent = false,
  ): { entry: T; anchor?: TranscriptEntryAnchor; lifecycleRevision?: string; appended: boolean } {
    this.assertTranscriptViewAvailable();
    const canonicalEntry = canonicalizeSessionEntry(entry, options);
    const activeBranchAppend =
      !preserveParent &&
      !this.pendingDeliberateAppend &&
      this.appendMode !== "side" &&
      !isSessionTranscriptSideAppendEntry(canonicalEntry);
    const persistenceOptions = copyCodeModeSourceAppendOptions(options, {
      ...options,
      ...(activeBranchAppend ? { appendIntent: "active-branch" as const } : {}),
    });
    const preparedTurnAppend =
      activeBranchAppend &&
      canonicalEntry.type === "message" &&
      (canonicalEntry.message.role === "assistant" ||
        canonicalEntry.message.role === "toolResult" ||
        // A nested send can advance the transcript before its tool activity is recorded.
        readNestedToolActivity(canonicalEntry.message) !== undefined);
    let attemptOptions: AppendPersistenceOptions & { expectedMutationAt?: number | null } =
      persistenceOptions;
    const admittedUserId = this.persistenceTarget
      ? resolveSessionTranscriptReadFence(this.persistenceTarget)?.entryId
      : undefined;
    if (preparedTurnAppend && this.persistenceTarget) {
      const validatedMutationAt = validatePreparedAssistantAppendSync(
        this.persistenceTarget,
        canonicalEntry.parentId,
        admittedUserId,
      );
      if (validatedMutationAt === undefined) {
        throw new SqliteTranscriptMutationConflictError(this.persistenceTarget.sessionId);
      }
      attemptOptions = copyCodeModeSourceAppendOptions(persistenceOptions, {
        ...persistenceOptions,
        expectedMutationAt: validatedMutationAt,
      });
    }
    // Keep preparation local to this append: retries must not redact the payload again or
    // consume its code-mode source token against a different message object.
    const preparedMessage =
      this.persistenceTarget && canonicalEntry.type === "message"
        ? prepareTranscriptMessageAppend(
            copyCodeModeSourceAppendOptions(options, {
              message: canonicalEntry.message,
              config: options?.config,
            }),
            {
              scope: this.persistenceTarget,
              envelope: {
                type: "message",
                id: canonicalEntry.id,
                parentId: canonicalEntry.parentId,
                timestamp: canonicalEntry.timestamp,
              },
            },
          )
        : undefined;
    let persistenceResult;
    try {
      persistenceResult = this.persistRecord(canonicalEntry, attemptOptions, preparedMessage);
    } catch (error) {
      const retryableExplicitParentAppend =
        this.pendingDeliberateAppend ||
        this.appendMode === "side" ||
        isSessionTranscriptSideAppendEntry(canonicalEntry);
      if (
        (!activeBranchAppend && !retryableExplicitParentAppend) ||
        !(error instanceof SqliteTranscriptMutationConflictError)
      ) {
        throw error;
      }
      const canRetryPreparedAppend =
        retryableExplicitParentAppend ||
        canonicalEntry.type !== "message" ||
        canonicalEntry.message.role === "user" ||
        preparedTurnAppend;
      if (!canRetryPreparedAppend) {
        throw error;
      }
      // Preserve the prepared parent so storage can distinguish a descendant tail from an
      // unrelated branch. Turn-bound assistant and tool-result messages may follow only a
      // descendant tail with no newer user turn; compatible reset and reentrant writes remain.
      let expectedMutationAt: number | null | undefined;
      if (preparedTurnAppend) {
        expectedMutationAt = this.persistenceTarget
          ? validatePreparedAssistantAppendSync(
              this.persistenceTarget,
              canonicalEntry.parentId,
              admittedUserId,
            )
          : undefined;
        if (expectedMutationAt === undefined) {
          throw error;
        }
      } else {
        expectedMutationAt = this.persistenceTarget
          ? readTranscriptMutationAtSync(this.persistenceTarget)
          : null;
      }
      const retryOptions = copyCodeModeSourceAppendOptions(persistenceOptions, {
        ...persistenceOptions,
        expectedMutationAt,
      });
      persistenceResult = this.persistRecord(canonicalEntry, retryOptions, preparedMessage);
    }
    return this.adoptPersistedEntry(canonicalEntry, persistenceResult, admittedUserId);
  }

  protected adoptWorkerCommittedEntry<T extends SessionEntry>(
    entry: T,
    committed: PersistWorkerRecordResult,
    admittedUserId?: string,
  ): {
    entry: T;
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
    viewWasSuperseded?: true;
  } {
    if (committed.viewFailure instanceof SessionManagerActorCommittedError) {
      throw committed.viewFailure;
    }
    if (this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
      if (
        committed.result?.adoptedMessageId &&
        !committed.result.appended &&
        this.resolveCurrentTurnEntryId(isTalkRealtimeVoiceEntry) !==
          committed.result.adoptedMessageId
      ) {
        throw new Error(
          `Session transcript keyed user is outside the current turn: ${committed.result.adoptedMessageId}`,
        );
      }
      // A native SDK append can publish a later view before the worker receipt arrives.
      return {
        entry: freezeJsonSnapshot({
          ...entry,
          id: committed.result?.adoptedMessageId ?? entry.id,
          parentId:
            committed.result?.effectiveParentId !== undefined
              ? committed.result.effectiveParentId
              : entry.parentId,
        }),
        anchor: committed.result?.anchor,
        lifecycleRevision: committed.result?.lifecycleRevision,
        appended: committed.result?.appended ?? true,
        viewWasSuperseded: true,
      };
    }
    if (committed.viewFailure) {
      throw committed.viewFailure;
    }
    this.transcriptVersion = committed.committedVersion;
    this.transcriptMutationAt = committed.committedVersion.updatedAt;
    return this.adoptPersistedEntry(entry, committed.result, admittedUserId, committed.reload);
  }

  protected adoptPersistedEntry<T extends SessionEntry>(
    canonicalEntry: T,
    persistenceResult: PersistRecordResult,
    admittedUserId?: string,
    preparedReload?: PreparedSessionTranscriptReload,
  ): { entry: T; anchor?: TranscriptEntryAnchor; lifecycleRevision?: string; appended: boolean } {
    if (persistenceResult?.adoptedMessageId) {
      if (preparedReload) {
        this.adoptPreparedTranscriptReload(preparedReload);
      } else {
        this.reloadPersistedTranscriptSync();
      }
      // Context-excluded users have no payload in byId. The exact SQLite replay
      // anchors their identity; physical ancestry still closes older turns.
      // Final Talk speech records history without consuming the consult's keyed input.
      if (
        this.resolveCurrentTurnEntryId(isTalkRealtimeVoiceEntry) !==
        persistenceResult.adoptedMessageId
      ) {
        throw new Error(
          `Session transcript keyed user is outside the current turn: ${persistenceResult.adoptedMessageId}`,
        );
      }
      canonicalEntry.id = persistenceResult.adoptedMessageId;
    } else if (
      persistenceResult?.reloadAfterAppend ||
      (persistenceResult?.effectiveParentId !== undefined &&
        persistenceResult.effectiveParentId !== canonicalEntry.parentId)
    ) {
      if (admittedUserId) {
        if (this.transcriptMutationAt === undefined) {
          throw new Error("Session transcript append mutation fence was not returned");
        }
        if (preparedReload) {
          this.adoptPreparedTranscriptReload(preparedReload, {
            expectedMutationAt: this.transcriptMutationAt,
            expectedEntryId: canonicalEntry.id,
            admittedUserId,
          });
        } else {
          this.reloadPersistedTranscriptAfterAppend(
            this.transcriptMutationAt,
            canonicalEntry.id,
            admittedUserId,
          );
        }
      } else if (preparedReload) {
        this.adoptPreparedTranscriptReload(preparedReload);
      } else {
        this.reloadPersistedTranscriptSync();
      }
    } else if (
      this.boundedContextIncomplete &&
      transcriptEventContextEligibility(canonicalEntry) === 0
    ) {
      // Match bounded hydration: SQLite owns display payloads; only the tail's ancestry is live.
      const parentId =
        !isSessionTranscriptSideAppendEntry(canonicalEntry) &&
        canonicalEntry.parentId === this.appendParentId &&
        this.leafId !== this.appendParentId
          ? this.leafId
          : this.resolveCanonicalParentId(canonicalEntry.parentId);
      if (this.appendParentId && this.appendParentId !== this.leafId && !this.appendMode) {
        this.opaqueParentsById.delete(this.appendParentId);
      }
      this.opaqueParentsById.set(canonicalEntry.id, parentId);
      this.appendParentId = canonicalEntry.id;
      if (isSessionTranscriptSideAppendEntry(canonicalEntry)) {
        this.appendMode = "side";
      } else {
        this.leafId = parentId;
        this.appendMode = undefined;
      }
    } else {
      if (
        !isSessionTranscriptSideAppendEntry(canonicalEntry) &&
        canonicalEntry.parentId === this.appendParentId &&
        this.leafId !== this.appendParentId
      ) {
        this.logicalParentsById.set(canonicalEntry.id, this.leafId);
      }
      this.fileEntries.push(canonicalEntry);
      // Reloaded views already include the committed boundary; count only local adoption.
      if (
        this.persistedBoundaryCount !== undefined &&
        (canonicalEntry.type === "compaction" || canonicalEntry.type === "reset")
      ) {
        this.persistedBoundaryCount += 1;
      }
      this.byId.set(canonicalEntry.id, canonicalEntry);
      this.appendParentId = canonicalEntry.id;
      if (isSessionTranscriptSideAppendEntry(canonicalEntry)) {
        this.appendMode = "side";
      } else {
        this.leafId = canonicalEntry.id;
        this.appendMode = undefined;
        // Bind opaque-only inherited state only after the visible append succeeds.
        this.cacheTtlProjectionPrefixes = this.cacheTtlProjectionPrefixes?.flatMap((prefix) => {
          if (prefix.anchorIds.length) {
            return [prefix];
          }
          return canonicalEntry.type === "reset" || canonicalEntry.type === "branch_summary"
            ? []
            : [{ ...prefix, anchorIds: [canonicalEntry.id] }];
        });
      }
      if (canonicalEntry.type === "label") {
        if (canonicalEntry.label) {
          this.labelsById.set(canonicalEntry.targetId, canonicalEntry.label);
          this.labelTimestampsById.set(canonicalEntry.targetId, canonicalEntry.timestamp);
        } else {
          this.labelsById.delete(canonicalEntry.targetId);
          this.labelTimestampsById.delete(canonicalEntry.targetId);
        }
      }
    }
    this.pendingDeliberateAppend = false;
    freezeJsonSnapshot(canonicalEntry);
    if (canonicalEntry.type === "message") {
      // Publish with the adopted view, before later native writes or worker replies can run.
      this.#lastMessageAppend = persistenceResult?.anchor
        ? {
            anchor: Object.freeze({ ...persistenceResult.anchor }),
            target: this.getSessionTarget(),
          }
        : undefined;
    }
    return {
      entry: canonicalEntry,
      anchor: persistenceResult?.anchor,
      lifecycleRevision: persistenceResult?.lifecycleRevision,
      // Detached managers append locally; only the storage owner supplies a durable anchor.
      appended: persistenceResult?.appended ?? true,
    };
  }

  // SDK v2026.9.5 exposes this synchronous opt-in; internal replay uses async preparation.
  resolveCurrentTurnEntryId(
    isInterruptedTail?: (entry: SessionEntry) => boolean,
    options?: { includeOmittedCustomMessages?: boolean },
  ): string | null {
    this.assertTranscriptViewAvailable();
    const includeOmitted = options?.includeOmittedCustomMessages === true;
    if (includeOmitted) {
      prepareSessionManagerSync(
        "resolveCurrentTurnEntryId",
        this.persistenceTarget,
        this,
        "openAsync, then resolveCurrentTurnEntryId without includeOmittedCustomMessages",
      );
    }
    return resolveCurrentTurnEntryId(
      {
        target: this.persistenceTarget,
        entries: this.byId,
        parentId: this.appendParentId,
        remainingAncestors: includeOmitted
          ? (this.boundedContextLimits?.maxEvents ?? this.byId.size + this.opaqueParentsById.size)
          : this.byId.size,
        isInterruptedTail,
      },
      includeOmitted,
    );
  }

  [sessionManagerPrepareCurrentTurnReplay](
    isInterruptedTail: (entry: SessionEntry) => boolean,
    matchesUser: (entry: SessionEntry | undefined) => boolean,
    signal?: AbortSignal,
  ) {
    return prepareCurrentTurnReplaySelection(
      () => {
        this.assertTranscriptViewAvailable();
        return {
          target: this.persistenceTarget,
          version: this.transcriptVersion,
          entries: this.byId,
          parentId: this.appendParentId,
          remainingAncestors:
            this.boundedContextLimits?.maxEvents ?? this.byId.size + this.opaqueParentsById.size,
          isInterruptedTail,
          pendingDeliberateAppend: this.pendingDeliberateAppend,
        };
      },
      matchesUser,
      signal,
      this,
    );
  }

  /** @deprecated Await appendMessageAsync. This method will be removed in the next Plugin SDK major. */
  appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    prepareSessionManagerSync("appendMessage", this.persistenceTarget, this);
    return this.appendMessageWithTranscriptAnchorSync(message, options).entryId;
  }

  async appendMessageAsync(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): Promise<string | undefined> {
    return (await this.appendMessageWithTranscriptAnchorAsync(message, options)).entryId;
  }

  async appendMessageWithTranscriptAnchorAsync(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): Promise<
    ReturnType<SessionManagerAppend["appendMessageWithTranscriptAnchor"]> & {
      viewWasSuperseded?: true;
    }
  > {
    if (message.role === "assistant") {
      applyAssistantDeliveryDirectives(message);
    }
    const appended = await this.appendEntryAsync<SessionMessageEntry>(
      {
        type: "message",
        id: generateSessionEntryId(),
        parentId: this.appendParentId,
        timestamp: new Date().toISOString(),
        message,
      },
      options,
    );
    return {
      entryId: appended.entry.id,
      message: appended.entry.message,
      anchor: appended.anchor,
      lifecycleRevision: appended.lifecycleRevision,
      appended: appended.appended,
      ...(appended.viewWasSuperseded ? { viewWasSuperseded: true as const } : {}),
    };
  }

  /** @deprecated Await appendMessageWithTranscriptAnchorAsync. This method will be removed in the next Plugin SDK major. */
  appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ) {
    prepareSessionManagerSync("appendMessageWithTranscriptAnchor", this.persistenceTarget, this);
    return this.appendMessageWithTranscriptAnchorSync(message, options);
  }

  protected appendMessageWithTranscriptAnchorSync(
    message: SessionMessageEntry["message"],
    options?: AppendPersistenceOptions,
  ): {
    entryId: string;
    message: SessionMessageEntry["message"];
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
  } {
    if (message.role === "assistant") {
      applyAssistantDeliveryDirectives(message);
    }
    if (
      options?.idempotencyLookup !== "caller-checked" &&
      message.role === "user" &&
      "idempotencyKey" in message &&
      typeof message.idempotencyKey === "string" &&
      message.idempotencyKey.length > 0
    ) {
      const currentTurnId = this.resolveCurrentTurnEntryId();
      const current = currentTurnId ? this.byId.get(currentTurnId) : undefined;
      if (
        current?.type === "message" &&
        current.message.role === "user" &&
        "idempotencyKey" in current.message &&
        current.message.idempotencyKey === message.idempotencyKey
      ) {
        const anchor = this.persistenceTarget
          ? readActiveTranscriptEntryAnchor({ ...this.persistenceTarget, entryId: current.id })
          : undefined;
        if (this.persistenceTarget && !anchor) {
          throw new Error(`Session transcript anchor was not returned: ${current.id}`);
        }
        return {
          entryId: current.id,
          message: current.message,
          ...(anchor ? { anchor } : {}),
          appended: false,
        };
      }
    }
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      message,
    };
    const {
      entry: persisted,
      anchor,
      lifecycleRevision,
      appended,
    } = this.appendEntry(entry, options);
    return {
      entryId: persisted.id,
      message: persisted.message,
      ...(anchor ? { anchor } : {}),
      lifecycleRevision,
      appended,
    };
  }
}
