import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadTranscriptSuffixEventsBoundedSync,
  readPreviousIndexedTranscriptEventSync,
  readTranscriptIdentityByEventId,
  readTranscriptMutationAtSync,
  replaceTranscriptSuffixEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type {
  SessionTranscriptMaintenanceRead,
  SessionTranscriptMaintenanceFacts,
} from "../../config/sessions/session-transcript-hydration.types.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "../../config/sessions/session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import type { SessionMaintenanceOperations } from "./session-manager-maintenance.worker.js";
import { SessionManagerPersistence } from "./session-manager-persistence.js";
import type { FileEntry, SessionEntry } from "./session-manager-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";
import {
  runSessionPersistenceAsync,
  runSessionPersistenceSync,
  sessionPersistenceStep,
  type SessionPersistenceStep,
} from "./session-persistence-operation.js";

export class SessionManagerSuffixPersistence extends SessionManagerPersistence {
  /** @deprecated Use removeTrailingEntriesAsync; removed at the next Plugin SDK major. */
  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    warnSessionPersistenceDeprecation(
      "SessionManager.removeTrailingEntries",
      "removeTrailingEntriesAsync",
    );
    return runSessionPersistenceSync(this.prepareTrailingEntriesRemoval(predicate, options));
  }

  async removeTrailingEntriesAsync(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): Promise<number> {
    return withSessionManagerWrite(this, async (admission) => {
      if (!admission || isIncognitoSessionKey(this.persistenceTarget?.sessionKey)) {
        // Incognito retains its process-held owner until the worker-owned migration activates.
        return runSessionPersistenceSync(this.prepareTrailingEntriesRemoval(predicate, options));
      }
      const target = this.persistenceTarget!;
      const identity = { ...target };
      const version = this.transcriptVersion;
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
      const assertCurrent = () => {
        this.assertTranscriptWriteActive();
        assertOwned();
        assertNavigation();
        if (
          !sameSessionTranscriptTargetBinding(identity, this.persistenceTarget) ||
          this.transcriptVersion !== version
        ) {
          throw new Error("Session transcript changed during suffix preparation");
        }
      };
      const reader = prepareSessionTranscriptHydration(target);
      const { env: _env, ...scope } = withOwnedSessionTranscriptWriterFence(target);
      const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
      assertCurrent();
      return withSessionMetadataWorker(
        admission.options,
        admission.database,
        assertCurrent,
        async (worker) =>
          runSessionPersistenceAsync(
            this.prepareTrailingEntriesRemoval(predicate, options, {
              read: async (request) => {
                const result = await reader.readMaintenance(request);
                reader.assertCurrent();
                assertCurrent();
                return result;
              },
              replace: async (args) => {
                const result = await worker.execute({
                  type: "session.transcript.replaceSuffix",
                  input: { scope: { ...scope, storePath: admission.database.path }, args },
                });
                if (result.projectionNeedsReconcile) {
                  startSessionTranscriptIndexReconcile({
                    ...admission.options,
                    preferredSessionId: identity.sessionId,
                  });
                }
                try {
                  assertCurrent();
                } catch (cause) {
                  const error = new Error(
                    "Session transcript suffix committed but view publication failed",
                    { cause },
                  );
                  error.name = "SessionSuffixCommittedError";
                  recordModelFallbackStop(error);
                  this.invalidateTranscriptView(error);
                  throw error;
                }
                return result;
              },
            }),
          ),
      );
    });
  }

  private *prepareTrailingEntriesRemoval(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
    worker?: {
      read(request: SessionTranscriptMaintenanceRead): Promise<SessionTranscriptMaintenanceFacts>;
      replace(
        args: SessionMaintenanceOperations["session.transcript.replaceSuffix"]["input"]["args"],
      ): Promise<SessionMaintenanceOperations["session.transcript.replaceSuffix"]["output"]>;
    },
  ): Generator<SessionPersistenceStep, number, void> {
    this.assertTranscriptWriteActive();
    const activeBranch = this.getBranch();
    let candidatePreservedStart = activeBranch.length;
    while (candidatePreservedStart > 0) {
      const entry = activeBranch[candidatePreservedStart - 1];
      if (!entry || !options?.preserveTrailing?.(entry)) {
        break;
      }
      candidatePreservedStart -= 1;
    }
    const removableEntryIds = new Set<string>();
    let candidateRemoveStart = candidatePreservedStart;
    while (candidateRemoveStart > 0) {
      const entry = activeBranch[candidateRemoveStart - 1];
      if (!entry || !predicate(entry)) {
        break;
      }
      removableEntryIds.add(entry.id);
      candidateRemoveStart -= 1;
    }
    if (candidateRemoveStart === candidatePreservedStart) {
      return 0;
    }
    if (
      this.boundedContextIncomplete &&
      candidateRemoveStart === 0 &&
      this.persistenceTarget &&
      this.persistedSuffixStartSeq !== undefined
    ) {
      const target = this.persistenceTarget;
      const beforeSeq = this.persistedSuffixStartSeq;
      const previous = yield* sessionPersistenceStep(
        () => readPreviousIndexedTranscriptEventSync(target, beforeSeq)?.event,
        worker
          ? async () => (await worker.read({ operation: "previous", beforeSeq })).previous
          : undefined,
      );
      // SAFETY: Indexed SQLite transcript rows deserialize to the persisted SessionEntry union.
      const previousEntry = previous as SessionEntry | undefined;
      if (previousEntry && predicate(previousEntry)) {
        throw new RangeError("Bounded transcript cleanup cannot cross the hydrated removal window");
      }
    }
    // Fence only an actual mutation. Defensive cleanup remains a no-op when its target is absent,
    // even if another writer advanced the durable transcript after this manager was opened.
    if (this.persistenceTarget && this.transcriptMutationAt !== undefined) {
      const target = this.persistenceTarget;
      const mutationAt = yield* sessionPersistenceStep(
        () => readTranscriptMutationAtSync(target),
        worker
          ? async () => (await worker.read({ operation: "version" })).version?.updatedAt
          : undefined,
      );
      if (mutationAt !== this.transcriptMutationAt) {
        throw new Error(
          `SQLite transcript changed while preparing suffix removal for ${this.persistenceTarget.sessionId}`,
        );
      }
    }
    const candidate = activeBranch[candidateRemoveStart];
    const target = this.persistenceTarget;
    const candidateSeq =
      target && isIndexedSessionEntry(candidate)
        ? yield* sessionPersistenceStep(
            () =>
              readTranscriptIdentityByEventId(
                openOpenClawAgentDatabase(
                  toDatabaseOptions(resolveSqliteTranscriptReadScope(target)),
                ),
                target.sessionId,
                candidate.id,
              )?.seq,
            worker
              ? async () =>
                  (await worker.read({ operation: "identity", eventId: candidate.id })).seq
              : undefined,
          )
        : undefined;
    const persistedSuffixStartSeq = candidateSeq ?? this.persistedSuffixStartSeq;
    const current = new SessionManagerSuffixPersistence(
      this.cwd,
      undefined,
      this.fileEntries,
      undefined,
      this.transcriptMutationAt,
    );
    current.opaqueFileEntries = this.opaqueFileEntries.map((entry) => ({ ...entry }));
    current.buildIndex();
    current.leafId = this.leafId;
    current.appendParentId = this.appendParentId;
    current.appendMode = this.appendMode;
    const currentEntries = current.getPersistedFileEntries();
    const candidatePersistedIndex = currentEntries.findIndex(
      (entry) => isRecord(entry) && entry.id === candidate?.id,
    );
    // Custom data never participates in topology or FTS. Keep loaded payloads by reference
    // while the storage owner carries their original bytes through the atomic suffix rewrite.
    const retainedCustomData = new Map<string, unknown>(
      this.boundedContextIncomplete && candidatePersistedIndex >= 0
        ? currentEntries
            .slice(candidatePersistedIndex, candidatePersistedIndex + SYNC_REBUILD_MAX_ROWS)
            .flatMap((entry) =>
              isRecord(entry) &&
              entry.type === "custom" &&
              typeof entry.id === "string" &&
              entry.data !== undefined
                ? [[entry.id, entry.data] as const]
                : [],
            )
        : [],
    );
    let retainedCustomDataIds = [...retainedCustomData.keys()];
    const restoreCustomData = <T>(entry: T): T =>
      isRecord(entry) &&
      entry.type === "custom" &&
      typeof entry.id === "string" &&
      retainedCustomData.has(entry.id)
        ? { ...entry, data: retainedCustomData.get(entry.id) }
        : entry;
    let retainedContextPrefix =
      persistedSuffixStartSeq !== undefined && candidatePersistedIndex >= 0
        ? currentEntries.slice(0, candidatePersistedIndex)
        : [];
    let expectedPersistedEntries = currentEntries;
    let useFullTranscriptFallback = false;
    if (this.persistenceTarget && persistedSuffixStartSeq !== undefined) {
      try {
        const suffixTarget = this.persistenceTarget;
        const limits = {
          maxBytes: SYNC_REBUILD_MAX_BYTES,
          maxEvents: SYNC_REBUILD_MAX_ROWS,
          retainedCustomDataIds,
        };
        expectedPersistedEntries = yield* sessionPersistenceStep(
          () =>
            loadTranscriptSuffixEventsBoundedSync(suffixTarget, persistedSuffixStartSeq, limits),
          worker
            ? async () => {
                const result = await worker.read({
                  operation: "suffix",
                  startSeq: persistedSuffixStartSeq,
                  ...limits,
                });
                if (!result.events) {
                  throw new Error("Session suffix reader returned no events");
                }
                return result.events;
              }
            : undefined,
        );
        // SQLite cannot project over-depth JSON. Those rows retain their complete payload
        // and stay on the ordinary exact-byte path rather than claiming an opaque reference.
        const projectedIds = new Set(
          expectedPersistedEntries.flatMap((entry) =>
            isRecord(entry) &&
            entry.type === "custom" &&
            typeof entry.id === "string" &&
            !Object.hasOwn(entry, "data")
              ? [entry.id]
              : [],
          ),
        );
        retainedCustomDataIds = retainedCustomDataIds.filter((id) => projectedIds.has(id));
      } catch (error) {
        const exceededPlanningLimit =
          error instanceof Error &&
          error.message.startsWith("Transcript suffix exceeds synchronous planning ");
        if (this.boundedContextIncomplete || !exceededPlanningLimit) {
          throw error;
        }
        retainedContextPrefix = [];
        expectedPersistedEntries = currentEntries;
        useFullTranscriptFallback = true;
      }
    }
    const preparedEntries = [...retainedContextPrefix, ...expectedPersistedEntries];
    const prepared = new SessionManagerSuffixPersistence(
      this.cwd,
      undefined,
      // SAFETY: Transcript suffix rows use the same persisted file-entry codec as full reads.
      preparedEntries as FileEntry[],
      undefined,
      this.transcriptMutationAt,
    );
    const restoreOmittedParentAncestry = (): void => {
      for (const [id, parentId] of this.opaqueParentsById) {
        if (!prepared.byId.has(id) && !prepared.opaqueParentsById.has(id)) {
          prepared.opaqueParentsById.set(id, parentId);
        }
      }
    };
    restoreOmittedParentAncestry();
    prepared.leafId = this.leafId;
    prepared.appendParentId = this.appendParentId;
    prepared.appendMode = this.appendMode;
    const removableIndexes: number[] = [];
    const removedEntries: SessionEntry[] = [];
    for (let index = 1; index < prepared.fileEntries.length; index += 1) {
      const entry = prepared.fileEntries[index];
      if (isIndexedSessionEntry(entry) && removableEntryIds.has(entry.id)) {
        removableIndexes.push(index);
        removedEntries.push(entry);
      }
    }
    if (removableIndexes.length !== removableEntryIds.size) {
      throw new Error(`SQLite session changed before trimming ${this.sessionId}`);
    }

    const shiftOpaqueIndexesAfterRemoval = (start: number, count: number): void => {
      for (const opaqueEntry of prepared.opaqueFileEntries) {
        const removedBeforeOpaque = Math.max(0, Math.min(count, opaqueEntry.index - start));
        opaqueEntry.index -= removedBeforeOpaque;
      }
    };
    const removeStart = removableIndexes[0];
    if (removeStart === undefined) {
      return 0;
    }
    const localPersistedPrefixLength =
      removeStart + prepared.opaqueFileEntries.filter((entry) => entry.index < removeStart).length;
    const preparedSuffixOffset = retainedContextPrefix.length;
    const persistedPrefixLength = useFullTranscriptFallback
      ? 0
      : (persistedSuffixStartSeq ?? Math.max(0, localPersistedPrefixLength - preparedSuffixOffset));
    const persistedBoundaryCount = this.persistedBoundaryCount;
    const removedBoundaryCount = removedEntries.filter(
      (entry) => entry.type === "compaction" || entry.type === "reset",
    ).length;
    const removedParentById = new Map(
      removedEntries.map((entry) => [entry.id, entry.parentId] as const),
    );
    const removedEntryIds = new Set(removableEntryIds);
    for (let index = removeStart; index < prepared.fileEntries.length; index += 1) {
      const entry = prepared.fileEntries[index];
      if (
        isIndexedSessionEntry(entry) &&
        entry.type === "label" &&
        removedEntryIds.has(entry.targetId)
      ) {
        removedEntryIds.add(entry.id);
        removedParentById.set(entry.id, entry.parentId);
      }
    }
    for (let index = prepared.fileEntries.length - 1; index >= removeStart; index -= 1) {
      const entry = prepared.fileEntries[index];
      if (!isIndexedSessionEntry(entry) || !removedEntryIds.has(entry.id)) {
        continue;
      }
      shiftOpaqueIndexesAfterRemoval(index, 1);
      prepared.fileEntries.splice(index, 1);
    }

    const resolveRetainedParentId = (parentId: string | null): string | null => {
      const seen = new Set<string>();
      let currentId = parentId;
      while (currentId && removedParentById.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId);
        currentId = removedParentById.get(currentId) ?? null;
      }
      return currentId;
    };
    const replacementParentId = resolveRetainedParentId(removedEntries[0]?.parentId ?? null);
    prepared.fileEntries = prepared.fileEntries.map((entry) => {
      if (!isIndexedSessionEntry(entry)) {
        return entry;
      }
      const parentId = resolveRetainedParentId(entry.parentId);
      return parentId === entry.parentId ? entry : { ...entry, parentId };
    });
    prepared.opaqueFileEntries = prepared.opaqueFileEntries.map((opaqueEntry) => {
      if (!isRecord(opaqueEntry.record)) {
        return opaqueEntry;
      }
      const record = opaqueEntry.record;
      const parentId =
        record.parentId === null || typeof record.parentId === "string"
          ? resolveRetainedParentId(record.parentId)
          : undefined;
      const leafEntry = parseOpaqueLeafEntry(record);
      const targetId = leafEntry ? resolveRetainedParentId(leafEntry.targetId) : undefined;
      const appendParentId =
        leafEntry?.appendParentId !== undefined
          ? resolveRetainedParentId(leafEntry.appendParentId)
          : undefined;
      if (
        (parentId === undefined || parentId === record.parentId) &&
        (targetId === undefined || targetId === leafEntry?.targetId) &&
        (appendParentId === undefined || appendParentId === leafEntry?.appendParentId)
      ) {
        return opaqueEntry;
      }
      return {
        ...opaqueEntry,
        record: {
          ...record,
          ...(parentId !== undefined ? { parentId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(appendParentId !== undefined ? { appendParentId } : {}),
        },
      };
    });

    prepared.clampOpaqueFileEntryIndexes();
    prepared.buildIndex();
    restoreOmittedParentAncestry();
    // The predecessor may be outside a bounded window but is still the durable active leaf.
    // Preserve its opaque identity so the serialized leaf control can restore it on a full reopen.
    prepared.leafId = replacementParentId;
    prepared.appendParentId = replacementParentId;
    const events = prepared.getPersistedFileEntries(prepared.appendParentId, prepared.appendMode);
    const suffixEvents = preparedSuffixOffset > 0 ? events.slice(preparedSuffixOffset) : events;
    const incrementalPlanningBytes = [...expectedPersistedEntries, ...suffixEvents].reduce<number>(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0,
    );
    if (
      !this.boundedContextIncomplete &&
      (expectedPersistedEntries.length + suffixEvents.length > SYNC_REBUILD_MAX_ROWS ||
        incrementalPlanningBytes > SYNC_REBUILD_MAX_BYTES)
    ) {
      expectedPersistedEntries = currentEntries;
      useFullTranscriptFallback = true;
    }
    const replacementEvents = useFullTranscriptFallback
      ? events.map(restoreCustomData)
      : suffixEvents;
    const adoptPrepared = (version?: typeof this.transcriptVersion) => {
      // Publish the detached tree before later post-commit observers can append through this manager.
      this.fileEntries = prepared.fileEntries.map(restoreCustomData);
      this.opaqueFileEntries = prepared.opaqueFileEntries;
      this.buildIndex();
      for (const [id, parentId] of prepared.opaqueParentsById) {
        if (!this.byId.has(id) && !this.opaqueParentsById.has(id)) {
          this.opaqueParentsById.set(id, parentId);
        }
      }
      this.leafId = prepared.leafId;
      this.appendParentId = prepared.appendParentId;
      this.appendMode = prepared.appendMode;
      this.pendingDeliberateAppend = prepared.pendingDeliberateAppend;
      this.boundedContextIncomplete = Boolean(this.boundedContextLimits && this.persistenceTarget);
      this.persistedBoundaryCount =
        persistedBoundaryCount === undefined
          ? undefined
          : Math.max(0, persistedBoundaryCount - removedBoundaryCount);
      this.persistedSuffixStartSeq = this.boundedContextIncomplete
        ? retainedContextPrefix.length > 0
          ? this.persistedSuffixStartSeq
          : persistedSuffixStartSeq
        : undefined;
      this.transcriptVersion = version;
      this.transcriptMutationAt = version?.updatedAt;
    };
    if (this.persistenceTarget) {
      const replacementTarget = this.persistenceTarget;
      const args: SessionMaintenanceOperations["session.transcript.replaceSuffix"]["input"]["args"] =
        [
          expectedPersistedEntries,
          replacementEvents,
          useFullTranscriptFallback ? 0 : persistedPrefixLength,
          this.transcriptMutationAt,
          persistedSuffixStartSeq !== undefined && !useFullTranscriptFallback,
          useFullTranscriptFallback ? [] : retainedCustomDataIds,
        ];
      const replaced = yield* sessionPersistenceStep(
        () =>
          replaceTranscriptSuffixEventsSync(
            replacementTarget,
            args[0],
            args[1],
            args[2],
            args[3],
            adoptPrepared,
            args[4],
            args[5],
          ),
        worker
          ? async () => {
              const result = await worker.replace(args);
              if (result.replaced) {
                adoptPrepared(result.version);
              }
              return result.replaced;
            }
          : undefined,
      );
      if (!replaced) {
        throw new Error(`SQLite session changed before trimming ${this.sessionId}`);
      }
    } else {
      adoptPrepared();
    }
    return removedEntries.length;
  }
}
