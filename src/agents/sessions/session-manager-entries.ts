import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  readActiveTranscriptEntryAnchor,
  readTranscriptMutationAtSync,
  validatePreparedAssistantAppendSync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { prepareTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { isSessionTranscriptSideAppendEntry } from "../../config/sessions/transcript-tree.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { ImageContent, Message, TextContent } from "../../llm/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { SessionTreeEntry as CoreSessionTreeEntry } from "../runtime/index.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { isOutOfTurnHistoryEntry } from "./session-manager-codec.js";
import {
  prepareCurrentTurnReplayWitness,
  resolveCurrentTurnEntryId,
  sessionManagerPrepareCurrentTurnReplay,
} from "./session-manager-current-turn.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import {
  canonicalizeSessionEntry,
  isSqliteTranscriptMutationConflict,
  type PersistRecordResult,
  type PersistWorkerRecordResult,
} from "./session-manager-persistence.js";
import { SessionManagerSuffixPersistence } from "./session-manager-suffix-persistence.js";
import type {
  AppendPersistenceOptions,
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  ResetEntry,
  ResetReason,
  SessionContext,
  SessionEntry,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionLeafControl,
} from "./session-manager-types.js";
import type { PreparedSessionTranscriptReload } from "./session-manager-view-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerEntries extends SessionManagerSuffixPersistence {
  protected appendEntry<T extends SessionEntry>(
    entry: T,
    options?: AppendPersistenceOptions,
  ): { entry: T; anchor?: TranscriptEntryAnchor; lifecycleRevision?: string; appended: boolean } {
    this.assertTranscriptViewAvailable();
    const canonicalEntry = canonicalizeSessionEntry(entry, options);
    const activeBranchAppend =
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
        throw this.createTranscriptMutationConflictError();
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
      const deliberateBranchAppend = this.pendingDeliberateAppend;
      const sideBranchAppend =
        this.appendMode === "side" || isSessionTranscriptSideAppendEntry(canonicalEntry);
      const retryableExplicitParentAppend = deliberateBranchAppend || sideBranchAppend;
      if (
        (!activeBranchAppend && !retryableExplicitParentAppend) ||
        !isSqliteTranscriptMutationConflict(error)
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
      const retryOptions: AppendPersistenceOptions & { expectedMutationAt?: number | null } =
        preparedTurnAppend
          ? (() => {
              const validatedMutationAt = this.persistenceTarget
                ? validatePreparedAssistantAppendSync(
                    this.persistenceTarget,
                    canonicalEntry.parentId,
                    admittedUserId,
                  )
                : undefined;
              if (validatedMutationAt === undefined) {
                throw error;
              }
              return copyCodeModeSourceAppendOptions(persistenceOptions, {
                ...persistenceOptions,
                expectedMutationAt: validatedMutationAt,
              });
            })()
          : copyCodeModeSourceAppendOptions(persistenceOptions, {
              ...persistenceOptions,
              expectedMutationAt: this.persistenceTarget
                ? readTranscriptMutationAtSync(this.persistenceTarget)
                : null,
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
    if (this.hasNewerPublishedTranscriptView(committed.committedVersion)) {
      // A native SDK append can publish a later view before the worker receipt arrives.
      return {
        entry: {
          ...entry,
          parentId:
            committed.result?.effectiveParentId !== undefined
              ? committed.result.effectiveParentId
              : entry.parentId,
        },
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
      this.reloadPersistedTranscript();
      // Context-excluded users have no payload in byId. The exact SQLite replay
      // anchors their identity; physical ancestry still closes older turns.
      // Final Talk speech and direct child-result mirrors record history
      // without consuming the open turn's keyed input.
      if (
        this.resolveCurrentTurnEntryId(isOutOfTurnHistoryEntry) !==
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
        this.reloadPersistedTranscript();
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
      }
    }
    this.pendingDeliberateAppend = false;
    return {
      entry: canonicalEntry,
      anchor: persistenceResult?.anchor,
      lifecycleRevision: persistenceResult?.lifecycleRevision,
      // Detached managers append locally; only the storage owner supplies a durable anchor.
      appended: persistenceResult?.appended ?? true,
    };
  }

  private createTranscriptMutationConflictError(): Error {
    const error = new Error(
      `SQLite transcript changed while preparing rewrite for ${this.persistenceTarget?.sessionId ?? this.sessionId}`,
    );
    error.name = "SqliteTranscriptMutationConflictError";
    return error;
  }

  // SDK v2026.9.5 exposes this synchronous opt-in; internal replay uses async preparation.
  resolveCurrentTurnEntryId(
    isInterruptedTail?: (entry: SessionEntry) => boolean,
    options?: { includeOmittedCustomMessages?: boolean },
  ): string | null {
    this.assertTranscriptViewAvailable();
    const includeOmitted = options?.includeOmittedCustomMessages === true;
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
    return prepareCurrentTurnReplayWitness(
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
        };
      },
      matchesUser,
      signal,
    );
  }

  appendMessage(
    message: Message | CustomMessage | BashExecutionMessage,
    options?: AppendPersistenceOptions,
  ): string {
    return this.appendMessageWithTranscriptAnchor(message, options).entryId;
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
    ReturnType<SessionManagerEntries["appendMessageWithTranscriptAnchor"]> & {
      viewWasSuperseded?: true;
    }
  > {
    return await withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      // User custody and process-local incognito storage retain their native owners.
      // The synchronous SDK also permits a transaction-local fresh-message callback.
      if (
        !admission ||
        isIncognitoSessionKey(this.persistenceTarget?.sessionKey) ||
        (message.role !== "assistant" && message.role !== "toolResult") ||
        options?.beforeFreshMessageCommit
      ) {
        return this.appendMessageWithTranscriptAnchor(message, options);
      }
      applyAssistantDeliveryDirectives(message);
      const canonical = canonicalizeSessionEntry<SessionMessageEntry>(
        {
          type: "message",
          id: generateSessionEntryId(),
          parentId: this.appendParentId,
          timestamp: new Date().toISOString(),
          message,
        },
        options,
      );
      const activeBranchAppend =
        !this.pendingDeliberateAppend &&
        this.appendMode !== "side" &&
        !isSessionTranscriptSideAppendEntry(canonical);
      const prepared = prepareTranscriptMessageAppend(
        copyCodeModeSourceAppendOptions(options, {
          message: canonical.message,
          config: options?.config,
        }),
      );
      if (!prepared) {
        throw new Error("Session message append requires prepared storage bytes");
      }
      const target = this.getSessionTarget();
      const sessionId = this.getSessionId();
      const admittedUserId = target
        ? resolveSessionTranscriptReadFence(target)?.entryId
        : undefined;
      const committed = await this.persistWorkerRecord(
        canonical,
        activeBranchAppend ? "active-branch" : undefined,
        admission,
        {
          prepared,
          cwd: this.cwd,
          validateTurn: activeBranchAppend,
          idempotencyLookup: options?.idempotencyLookup,
        },
      );
      try {
        if (
          this.getSessionId() !== sessionId ||
          !sameSessionTranscriptTargetBinding(target, this.getSessionTarget())
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        const appended = this.adoptWorkerCommittedEntry(canonical, committed, admittedUserId);
        return {
          entryId: appended.entry.id,
          message: appended.entry.message,
          anchor: appended.anchor,
          lifecycleRevision: appended.lifecycleRevision,
          appended: appended.appended,
          ...(appended.viewWasSuperseded ? { viewWasSuperseded: true as const } : {}),
        };
      } catch (cause) {
        const error = new Error(
          "Session message committed, but its view could not be adopted; do not replay the append",
          { cause },
        );
        error.name = "SessionMessageCommittedError";
        recordModelFallbackStop(error);
        this.invalidateTranscriptView(error);
        throw error;
      }
    });
  }

  appendMessageWithTranscriptAnchor(
    message: Message | CustomMessage | BashExecutionMessage,
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

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    metadata?: CompactionEntry["__openclaw"],
    tokensAfter?: number,
  ): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      details,
      fromHook,
      ...(metadata?.runId || metadata?.itemId ? { __openclaw: metadata } : {}),
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }

  appendResetBoundary(reason: ResetReason, firstKeptEntryId?: string): string {
    const entry: ResetEntry = {
      type: "reset",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      reason,
      ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: "session_info",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      name: name.replace(/[\r\n]+/g, " ").trim(),
    };
    this.appendEntry(entry);
    return entry.id;
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    const entry: CustomMessageEntry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
    };
    this.appendEntry(entry, { invalidateSerializedPrefixCache: true });
    return entry.id;
  }

  appendLeafControl(params: {
    targetId: string | null;
    appendParentId: string | null;
    appendMode?: "side";
  }): SessionLeafControl {
    this.assertTranscriptViewAvailable();
    if (params.targetId !== null && !this.byId.has(params.targetId)) {
      throw new Error(`Entry ${params.targetId} not found`);
    }
    if (
      params.appendParentId !== null &&
      !this.byId.has(params.appendParentId) &&
      !this.opaqueParentsById.has(params.appendParentId)
    ) {
      throw new Error(`Append parent ${params.appendParentId} not found`);
    }
    const previousLeafId = this.leafId;
    this.leafId = params.targetId;
    const entry = this.createLeafControl(
      this.appendParentId,
      params.appendParentId,
      params.appendMode,
    );
    this.leafId = previousLeafId;
    this.persistRecord(entry);
    this.rememberLeafControl(entry);
    this.leafId = params.targetId;
    this.appendParentId = params.appendParentId;
    this.appendMode = params.appendMode;
    this.pendingDeliberateAppend = false;
    return entry;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: "label",
      id: generateSessionEntryId(),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  buildSessionContext(): SessionContext {
    return buildCoreSessionContext(this.getBranch() as CoreSessionTreeEntry[]) as SessionContext;
  }

  branch(branchFromId: string): void {
    this.assertTranscriptViewAvailable();
    if (!this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchTargetId;
    this.appendParentId = branchTargetId;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  resetLeaf(): void {
    this.assertTranscriptViewAvailable();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = true;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      this.ensureCompletePersistedHistory();
    }
    const branchTargetId = branchFromId === null ? null : this.resolveBranchTargetId(branchFromId);
    if (branchTargetId === undefined) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      type: "branch_summary",
      id: generateSessionEntryId(),
      parentId: branchTargetId,
      timestamp: new Date().toISOString(),
      fromId: branchTargetId ?? "root",
      summary,
      details,
      fromHook,
    };
    this.appendEntry(entry, {
      invalidateSerializedPrefixCache: fromHook === true || details !== undefined,
    });
    return entry.id;
  }
}
