import { inspectTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import {
  resolveOpaqueSessionFirstKeptEntryId,
  SessionEntryNavigation,
} from "../../config/sessions/session-entry-navigation.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "./session-manager-codec.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
import type {
  FileEntry,
  NewSessionOptions,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
  SessionInfoEntry,
  SessionTreeNode,
  SessionLeafControl,
} from "./session-manager-types.js";
import type {
  SessionManagerPersistenceTarget,
  SessionManagerBoundedContextLimits,
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContext,
} from "./session-manager-view-types.js";
import { warnSessionPersistenceDeprecation } from "./session-persistence-deprecation.js";

export class SessionManagerCore extends SessionEntryNavigation<SessionEntry> {
  migrated = false;
  protected sessionId = "";
  protected transcriptVersion: SessionTranscriptContextVersion | undefined;
  private transcriptViewFailure: Error | undefined;
  private hydrationRevision = 0;
  protected cwd: string;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  protected boundedParentIds = new Map<string, string | null>();
  private boundedFirstKeptById = new Map<string, string>();
  protected pendingDeliberateAppend = false;
  protected persistenceTarget: SessionManagerPersistenceTarget | undefined;
  protected persistenceHeaderPending = false;
  protected boundedContextLimits: SessionManagerBoundedContextLimits | undefined;
  protected boundedContextIncomplete = false;
  protected persistedBoundaryCount: number | undefined;
  protected persistedSuffixStartSeq: number | undefined;
  protected transcriptMutationAt: number | null | undefined;

  constructor(
    cwd: string,
    persistenceTarget?: SessionManagerPersistenceTarget,
    loadedEntries?: readonly unknown[],
    boundedContext?: SessionManagerBoundedContext,
    transcriptMutationAt?: number | null,
    version?: SessionTranscriptContextVersion,
  ) {
    super();
    this.cwd = cwd;
    this.persistenceTarget = persistenceTarget;
    this.boundedContextLimits = boundedContext?.limits;
    this.boundedContextIncomplete = boundedContext !== undefined;
    this.persistedBoundaryCount = boundedContext?.boundaryCount;
    this.persistedSuffixStartSeq = boundedContext?.persistedSuffixStartSeq;
    this.transcriptMutationAt =
      boundedContext !== undefined ? boundedContext.transcriptMutationAt : transcriptMutationAt;
    this.transcriptVersion = version ?? boundedContext?.version;
    if (persistenceTarget || loadedEntries) {
      this.setLoadedSessionTarget(persistenceTarget, loadedEntries ?? [], boundedContext, version);
    } else {
      this.newSession();
    }
  }

  /** @deprecated Runtime callers should await setSessionTargetAsync. */
  setSessionTarget(target: SessionTranscriptRuntimeTarget): void {
    warnSessionPersistenceDeprecation("SessionManager.setSessionTarget", "setSessionTargetAsync");
    this.setSessionTargetSync(target);
  }

  protected setSessionTargetSync(target: SessionTranscriptRuntimeTarget): void {
    this.assertTranscriptViewAvailable();
    this.hydrationRevision++;
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const bounded = this.boundedContextLimits
      ? readSessionTranscriptBoundedActiveContextCore(capturedTarget, this.boundedContextLimits)
      : undefined;
    const snapshot = bounded ? undefined : loadTranscriptReadSnapshotSync(capturedTarget);
    const entries = (bounded?.events ?? snapshot?.events ?? []) as FileEntry[];
    this.boundedContextIncomplete = bounded !== undefined;
    this.persistedBoundaryCount = bounded?.boundaryCount;
    this.persistedSuffixStartSeq = bounded?.persistedSuffixStartSeq;
    this.transcriptMutationAt =
      bounded !== undefined ? bounded.transcriptMutationAt : snapshot?.version.updatedAt;
    const header = entries.find(
      (entry) => typeof entry === "object" && entry !== null && entry.type === "session",
    );
    this.setLoadedSessionTarget(
      capturedTarget,
      entries,
      bounded,
      bounded?.version ?? snapshot?.version,
    );
    if (header?.cwd) {
      this.cwd = header.cwd;
    }
  }

  /** Prepare off-thread and publish the entire view only while this manager is unchanged. */
  setSessionTargetAsync(
    target: SessionTranscriptRuntimeTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.hydrateSessionTarget(target, false, signal);
  }

  private async hydrateSessionTarget(
    target: SessionTranscriptRuntimeTarget,
    preserveCwd: boolean,
    signal?: AbortSignal,
    complete = false,
  ): Promise<void> {
    this.assertTranscriptViewAvailable();
    const hydration = prepareSessionTranscriptHydration(
      target,
      complete ? undefined : this.boundedContextLimits,
      signal,
    );
    const assertOwned = captureOwnedTranscriptWriteAssertion(hydration.target);
    const revision = ++this.hydrationRevision;
    const prior = this.captureTranscriptView();
    const entryCount = this.fileEntries.length;
    const opaqueCount = this.opaqueFileEntries.length;
    assertOwned();
    const prepared = await hydration.read().catch((error: unknown) => {
      assertOwned();
      throw error;
    });
    signal?.throwIfAborted();
    assertOwned();
    hydration.assertCurrent();
    this.assertTranscriptViewAvailable();
    const current = this.captureTranscriptView();
    if (
      revision !== this.hydrationRevision ||
      this.fileEntries.length !== entryCount ||
      this.opaqueFileEntries.length !== opaqueCount ||
      Object.keys(prior).some((key) => Reflect.get(prior, key) !== Reflect.get(current, key))
    ) {
      throw new Error("Session manager changed during transcript hydration");
    }
    this.adoptPreparedTranscriptReload(prepared, undefined, hydration.target);
    if (!preserveCwd) {
      this.cwd = this.fileEntries.find((entry) => entry.type === "session")?.cwd ?? this.cwd;
    }
    this.hydrationRevision++;
  }

  /** Reload an existing view without changing the runtime working directory. */
  async reloadPersistedTranscriptAsync(signal?: AbortSignal): Promise<void> {
    if (!this.persistenceTarget) {
      return;
    }
    await this.hydrateSessionTarget(this.persistenceTarget, true, signal);
  }

  /** Active-only loads can omit sibling rows even when they fit the context limits. */
  protected ensureCompletePersistedHistory(): void {
    this.assertTranscriptViewAvailable();
    if (!this.persistenceTarget || !this.boundedContextIncomplete) {
      return;
    }
    const limits = this.boundedContextLimits;
    this.boundedContextLimits = undefined;
    this.setSessionTargetSync(this.persistenceTarget);
    this.boundedContextLimits = limits;
  }

  protected async ensureCompletePersistedHistoryAsync(): Promise<void> {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget && this.boundedContextIncomplete) {
      await this.hydrateSessionTarget(this.persistenceTarget, true, undefined, true);
    }
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: readonly unknown[],
    bounded?: Pick<
      SessionTranscriptBoundedActiveContext,
      "activeLeafEntryId" | "version" | "opaqueParents" | "parents" | "firstKeptRanges"
    >,
    version?: SessionTranscriptContextVersion,
  ): void {
    this.assertTranscriptViewAvailable();
    this.transcriptVersion = version ?? bounded?.version;
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    const partitioned = partitionSessionFileEntries(entries);
    // Only a physically empty transcript may initialize lazily. Opaque persisted rows still need
    // a canonical header, or runtime would silently replace malformed history with a fresh session.
    if (partitioned.fileEntries.length === 0 && partitioned.opaqueEntries.length === 0) {
      this.persistenceTarget = target ? captureSessionTranscriptTargetBinding(target) : undefined;
      this.initializeSession({ id: target?.sessionId });
      this.persistenceHeaderPending = target !== undefined;
      return;
    }
    const header = partitioned.fileEntries.find((entry) => entry.type === "session");
    if (target) {
      assertCurrentSessionTranscriptHeader(header);
    }
    this.persistenceHeaderPending = false;
    this.persistenceTarget = target ? captureSessionTranscriptTargetBinding(target) : undefined;
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    this.sessionId = header?.id ?? target?.sessionId ?? createManagedSessionId();
    this.migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
    if (bounded) {
      this.boundedParentIds = new Map(bounded.parents);
      for (const [id, parentId] of bounded.opaqueParents) {
        this.opaqueParentsById.set(id, parentId);
      }
      this.adoptSelectedTranscriptPath(bounded.activeLeafEntryId, bounded.parents);
      for (const [boundaryId, range] of bounded.firstKeptRanges) {
        // An empty retained slice starts at the boundary itself, never at an
        // earlier ancestor. Opaque entries do not become model-context cut points.
        let firstKeptEntryId = boundaryId;
        for (let index = range.startIndex; index < range.endIndex; index++) {
          const entry = partitioned.fileEntriesByOriginalIndex[index];
          if (isIndexedSessionEntry(entry)) {
            firstKeptEntryId = entry.id;
            break;
          }
        }
        this.boundedFirstKeptById.set(boundaryId, firstKeptEntryId);
      }
    }
  }

  protected adoptSelectedTranscriptPath(
    appendParentId: string | null,
    parents: Iterable<readonly [string, string | null]>,
  ): void {
    // Selected payloads omit navigation controls. Use their resolved ancestry,
    // not the side-append parent guesses made while indexing those payloads.
    this.logicalParentsById.clear();
    for (const [id, parentId] of parents) {
      this.logicalParentsById.set(id, this.resolveCanonicalParentId(parentId));
    }
    this.appendParentId = appendParentId;
    this.leafId = this.resolveOpaqueLeafTargetId(appendParentId);
    this.appendMode = undefined;
  }

  /** The loaded view only: bounded managers must never hydrate inactive history for a rewrite. */
  protected captureTranscriptView(copy = false) {
    this.assertTranscriptViewAvailable();
    return {
      sessionId: this.sessionId,
      transcriptVersion: this.transcriptVersion,
      persistenceHeaderPending: this.persistenceHeaderPending,
      migrated: this.migrated,
      fileEntries: copy ? [...this.fileEntries] : this.fileEntries,
      opaqueFileEntries: copy
        ? this.opaqueFileEntries.map((entry) => ({ ...entry }))
        : this.opaqueFileEntries,
      byId: copy ? new Map(this.byId) : this.byId,
      opaqueParentsById: copy ? new Map(this.opaqueParentsById) : this.opaqueParentsById,
      logicalParentsById: copy ? new Map(this.logicalParentsById) : this.logicalParentsById,
      invalidLeafControlIds: copy
        ? new Set(this.invalidLeafControlIds)
        : this.invalidLeafControlIds,
      labelsById: copy ? new Map(this.labelsById) : this.labelsById,
      labelTimestampsById: copy ? new Map(this.labelTimestampsById) : this.labelTimestampsById,
      boundedFirstKeptById: copy ? new Map(this.boundedFirstKeptById) : this.boundedFirstKeptById,
      boundedParentIds: copy ? new Map(this.boundedParentIds) : this.boundedParentIds,
      boundedContextIncomplete: this.boundedContextIncomplete,
      boundedContextLimits: this.boundedContextLimits,
      persistedBoundaryCount: this.persistedBoundaryCount,
      persistedSuffixStartSeq: this.persistedSuffixStartSeq,
      transcriptMutationAt: this.transcriptMutationAt,
      leafId: this.leafId,
      appendParentId: this.appendParentId,
      appendMode: this.appendMode,
      pendingDeliberateAppend: this.pendingDeliberateAppend,
    };
  }

  /** @deprecated Runtime callers should await reloadPersistedTranscriptAsync. */
  reloadPersistedTranscript(): void {
    warnSessionPersistenceDeprecation(
      "SessionManager.reloadPersistedTranscript",
      "reloadPersistedTranscriptAsync",
    );
    this.reloadPersistedTranscriptSync();
  }

  protected reloadPersistedTranscriptSync(): void {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget) {
      const runtimeCwd = this.cwd;
      this.setSessionTargetSync(this.persistenceTarget);
      this.cwd = runtimeCwd;
    }
  }

  /** Reloads a committed append without adopting a later user turn. */
  protected reloadPersistedTranscriptAfterAppend(
    expectedMutationAt: number | null,
    expectedEntryId: string,
    admittedUserId: string,
  ): void {
    if (!this.persistenceTarget) {
      return;
    }
    const target = this.persistenceTarget;
    if (this.boundedContextLimits) {
      this.adoptPreparedTranscriptReload(
        {
          kind: "bounded",
          snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
            ...this.boundedContextLimits,
            ignoreReadFence: true,
          }),
        },
        { expectedMutationAt, expectedEntryId, admittedUserId },
      );
    } else {
      const inspected = inspectTranscriptEventsSync(target);
      this.adoptPreparedTranscriptReload(
        {
          kind: "full",
          snapshot: {
            events: inspected.events,
            version: {
              generation: inspected.snapshot.generation,
              rawSeq: inspected.snapshot.lastSeq,
              updatedAt: inspected.snapshot.transcriptUpdatedAt,
            },
          },
        },
        { expectedMutationAt, expectedEntryId, admittedUserId },
      );
    }
  }

  /** Adopt owner-prepared bytes without reading SQLite again on the receiving thread. */
  protected adoptPreparedTranscriptReload(
    prepared: PreparedSessionTranscriptReload,
    append?: { expectedMutationAt: number | null; expectedEntryId: string; admittedUserId: string },
    target = this.persistenceTarget,
  ): void {
    if (!target) {
      return;
    }
    const { events, version } = prepared.snapshot;
    const bounded = prepared.kind === "bounded" ? prepared.snapshot : undefined;
    const mutationAt = bounded ? bounded.transcriptMutationAt : version.updatedAt;
    if (
      append &&
      mutationAt !== append.expectedMutationAt &&
      !events.some((entry) => isIndexedSessionEntry(entry) && entry.id === append.expectedEntryId)
    ) {
      throw new Error("SQLite transcript changed before adopting the committed append");
    }
    // Validate the replacement before publication; the retained view needs no rollback copy.
    const candidate = new SessionManagerCore(this.cwd);
    candidate.boundedContextLimits = this.boundedContextLimits;
    candidate.boundedContextIncomplete = bounded !== undefined;
    candidate.persistedBoundaryCount = bounded?.boundaryCount;
    candidate.persistedSuffixStartSeq = bounded?.persistedSuffixStartSeq;
    candidate.transcriptMutationAt = mutationAt;
    candidate.setLoadedSessionTarget(target, events, bounded, version);
    if (append) {
      const activeBranch = candidate.getBranch();
      const admittedUserIndex = activeBranch.findIndex(
        (entry) => entry.id === append.admittedUserId,
      );
      const activeBranchHasNewerUser =
        admittedUserIndex < 0 ||
        activeBranch
          .slice(admittedUserIndex + 1)
          .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (activeBranchHasNewerUser) {
        candidate.adoptSelectedTranscriptPath(
          append.expectedEntryId,
          [...candidate.byId].map(([id, entry]) => [id, entry.parentId]),
        );
      }
    }
    Object.assign(this, candidate.captureTranscriptView());
    this.persistenceTarget = candidate.persistenceTarget;
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.persistenceTarget) {
      throw new Error("Persisted session managers cannot change session identity in place");
    }
    return this.initializeSession(options);
  }

  private initializeSession(options?: NewSessionOptions): string | undefined {
    this.sessionId = options?.id ?? this.persistenceTarget?.sessionId ?? createManagedSessionId();
    this.migrated = false;
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.opaqueFileEntries = [];
    this.clearNavigation();
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    this.pendingDeliberateAppend = false;
    return this.persistenceTarget ? this.sessionId : undefined;
  }

  protected buildIndex(): void {
    this.clearNavigation();
    this.pendingDeliberateAppend = false;
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        this.appendOpaqueNavigationRecord(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      // Current entries were validated by partition/append. Legacy imports retain readable rows
      // through migration, so only those need the final shape check before indexing.
      if (!entry || entry.type === "session" || (this.migrated && !isIndexedSessionEntry(entry))) {
        continue;
      }
      this.appendCanonicalNavigationEntry(entry);
    }
    this.finishNavigation();
  }

  protected override normalizeEntryParent(entry: SessionEntry): SessionEntry {
    let normalized = super.normalizeEntryParent(entry);
    const boundedFirstKept = this.boundedFirstKeptById.get(normalized.id);
    if (
      boundedFirstKept !== undefined &&
      (normalized.type === "compaction" || normalized.type === "reset")
    ) {
      normalized = { ...normalized, firstKeptEntryId: boundedFirstKept };
    }
    if (
      (normalized.type === "compaction" || normalized.type === "reset") &&
      normalized.firstKeptEntryId !== undefined &&
      !this.byId.has(normalized.firstKeptEntryId) &&
      this.opaqueParentsById.has(normalized.firstKeptEntryId)
    ) {
      const firstKeptEntryId = resolveOpaqueSessionFirstKeptEntryId({
        firstKeptEntryId: normalized.firstKeptEntryId,
        parentId: normalized.parentId,
        fallbackParentId: this.resolveEntryParentId(entry),
        byId: this.byId,
        opaqueParentsById: this.opaqueParentsById,
        entries: () => this.fileEntries.filter(isIndexedSessionEntry),
      });
      if (firstKeptEntryId && firstKeptEntryId !== normalized.firstKeptEntryId) {
        normalized = { ...normalized, firstKeptEntryId };
      }
    }
    return normalized;
  }

  protected resolveBranchTargetId(branchFromId: string): string | null | undefined {
    if (this.byId.has(branchFromId)) {
      return branchFromId;
    }
    return this.opaqueParentsById.has(branchFromId)
      ? this.resolveCanonicalParentId(branchFromId)
      : undefined;
  }

  protected clampOpaqueFileEntryIndexes(): void {
    let previousOpaqueIndex = 0;
    for (const opaqueEntry of this.opaqueFileEntries) {
      opaqueEntry.index = Math.max(
        previousOpaqueIndex,
        Math.min(opaqueEntry.index, this.fileEntries.length),
      );
      previousOpaqueIndex = opaqueEntry.index;
    }
  }

  protected createLeafControl(
    parentId: string | null,
    appendParentId: string | null = this.appendParentId,
    appendMode?: "side",
  ): SessionLeafControl {
    return {
      type: "leaf",
      id: generateSessionEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      targetId: this.leafId,
      ...(appendParentId !== this.leafId ? { appendParentId } : {}),
      ...(appendMode ? { appendMode } : {}),
    };
  }

  protected rememberLeafControl(leafEntry: SessionLeafControl): void {
    this.opaqueFileEntries.push({ index: this.fileEntries.length, record: leafEntry });
    this.opaqueParentsById.set(leafEntry.id, leafEntry.targetId);
  }

  getSessionName(): string | undefined {
    this.assertTranscriptViewAvailable();
    const sessionInfo = this.fileEntries.findLast(
      (entry): entry is SessionInfoEntry =>
        entry.type === "session_info" && this.byId.has(entry.id),
    );
    return sessionInfo?.name?.trim() || undefined;
  }

  getChildren(parentId: string): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    const children: SessionEntry[] = [];
    for (const entry of this.byId.values()) {
      const normalizedEntry = this.normalizeEntryParent(entry);
      if (normalizedEntry.parentId === parentId) {
        children.push(normalizedEntry);
      }
    }
    return children;
  }

  getLabel(id: string): string | undefined {
    this.assertTranscriptViewAvailable();
    return this.labelsById.get(id);
  }

  getBoundaryCount(): number {
    this.assertTranscriptViewAvailable();
    return (
      this.persistedBoundaryCount ??
      this.getBranch().filter((entry) => entry.type === "compaction" || entry.type === "reset")
        .length
    );
  }

  getHeader(): SessionHeader | null {
    this.assertTranscriptViewAvailable();
    return this.fileEntries.find((entry) => entry.type === "session") ?? null;
  }

  getEntries(): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    return this.fileEntries
      .filter((entry): entry is SessionEntry => entry.type !== "session" && this.byId.has(entry.id))
      .map((entry) => this.normalizeEntryParent(entry));
  }

  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      nodeMap.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      const parentId = this.resolveCanonicalParentId(entry.parentId);
      const parent = parentId !== null && parentId !== entry.id ? nodeMap.get(parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(
        (left, right) =>
          new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
      );
      stack.push(...node.children);
    }
    return roots;
  }

  getLeafId(): string | null {
    this.assertTranscriptViewAvailable();
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    this.assertTranscriptViewAvailable();
    return this.leafId ? this.getEntry(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    this.assertTranscriptViewAvailable();
    const entry = this.byId.get(id);
    return entry ? this.normalizeEntryParent(entry) : undefined;
  }

  getAppendParentId(): string | null {
    this.assertTranscriptViewAvailable();
    return this.appendParentId;
  }

  getAppendMode(): "side" | undefined {
    this.assertTranscriptViewAvailable();
    return this.appendMode;
  }

  protected getPersistedFileEntries(
    leafAppendParentId: string | null = this.appendParentId,
    leafAppendMode?: "side",
  ): unknown[] {
    this.assertTranscriptViewAvailable();
    this.clampOpaqueFileEntryIndexes();
    const entries: unknown[] = [];
    let opaqueIndex = 0;
    for (let index = 0; index <= this.fileEntries.length; index += 1) {
      while (this.opaqueFileEntries[opaqueIndex]?.index === index) {
        entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
        opaqueIndex += 1;
      }
      const entry = this.fileEntries[index];
      if (entry) {
        entries.push(entry);
      }
    }
    while (opaqueIndex < this.opaqueFileEntries.length) {
      entries.push(this.opaqueFileEntries[opaqueIndex]?.record);
      opaqueIndex += 1;
    }

    let persistedLeafId: string | null = null;
    let persistedAppendParentId: string | null = null;
    let rawTailId: string | null = null;
    for (const entry of entries) {
      const leafEntry = parseOpaqueLeafEntry(entry);
      if (leafEntry) {
        rawTailId = leafEntry.id;
        if (this.invalidLeafControlIds.has(leafEntry.id)) {
          continue;
        }
        const targetId = this.resolveOpaqueLeafTargetId(leafEntry.targetId);
        persistedLeafId = targetId;
        persistedAppendParentId =
          leafEntry.appendParentId === undefined
            ? targetId
            : this.resolveOpaqueAppendParentId(leafEntry.appendParentId);
        continue;
      }
      if (isIndexedSessionEntry(entry)) {
        persistedLeafId = entry.id;
        persistedAppendParentId = entry.id;
        rawTailId = entry.id;
        continue;
      }
      const opaqueLink = parseParentLinkedOpaqueEntry(entry);
      if (opaqueLink) {
        persistedAppendParentId = opaqueLink.id;
        rawTailId = opaqueLink.id;
      }
    }
    if (persistedLeafId !== this.leafId || persistedAppendParentId !== this.appendParentId) {
      const leafEntry = this.createLeafControl(rawTailId, leafAppendParentId, leafAppendMode);
      this.rememberLeafControl(leafEntry);
      entries.push(leafEntry);
    }
    return entries;
  }

  getPersistedEntries(): unknown[] {
    return this.getPersistedFileEntries();
  }

  clearPreservedOpaqueFileEntries(): void {
    this.assertTranscriptViewAvailable();
    this.opaqueFileEntries = [];
    this.opaqueParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.appendParentId = null;
    this.appendMode = undefined;
    this.pendingDeliberateAppend = false;
  }

  protected invalidateTranscriptView(error: Error): void {
    this.transcriptViewFailure = error;
    this.transcriptVersion = undefined;
  }

  protected assertTranscriptViewAvailable(): void {
    if (this.transcriptViewFailure) {
      throw this.transcriptViewFailure;
    }
  }

  override getBranch(fromId?: string): SessionEntry[] {
    this.assertTranscriptViewAvailable();
    return super.getBranch(fromId);
  }

  isPersisted(): boolean {
    return this.persistenceTarget !== undefined;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionTarget(): SessionManagerPersistenceTarget | undefined {
    const target = this.persistenceTarget;
    return target ? { ...target, ...(target.env ? { env: { ...target.env } } : {}) } : undefined;
  }
}
