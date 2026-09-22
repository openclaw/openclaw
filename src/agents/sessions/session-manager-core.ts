import path from "node:path";
import {
  inspectTranscriptEventsSync,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionTranscriptBoundedActiveContextCore,
  type SessionTranscriptBoundedActiveContext,
} from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { loadTranscriptReadSnapshotSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { assertCurrentSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import {
  resolveOpaqueSessionFirstKeptEntryId,
  SessionEntryNavigation,
} from "../../config/sessions/session-entry-navigation.js";
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

export type SessionManagerPersistenceTarget = SessionTranscriptRuntimeTarget;
export type SessionManagerBoundedContextLimits = { maxBytes: number; maxEvents: number };
export type PreparedSessionTranscriptReload =
  | { kind: "full"; snapshot: ReturnType<typeof loadTranscriptReadSnapshotSync> }
  | { kind: "bounded"; snapshot: SessionTranscriptBoundedActiveContext };
export type SessionManagerBoundedContext = Pick<
  SessionTranscriptBoundedActiveContext,
  | "activeLeafEntryId"
  | "version"
  | "opaqueParents"
  | "parents"
  | "firstKeptRanges"
  | "persistedSuffixStartSeq"
  | "boundaryCount"
  | "transcriptMutationAt"
> & { limits: SessionManagerBoundedContextLimits };

export class SessionManagerCore extends SessionEntryNavigation<SessionEntry> {
  migrated = false;
  protected sessionId = "";
  protected transcriptVersion: SessionTranscriptContextVersion | undefined;
  private transcriptViewFailure: Error | undefined;
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
    loadedEntries?: FileEntry[],
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

  setSessionTarget(target: SessionManagerPersistenceTarget): void {
    this.assertTranscriptViewAvailable();
    const capturedTarget = { ...target, storePath: path.resolve(target.storePath) };
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

  /** Active-only loads can omit sibling rows even when they fit the context limits. */
  protected ensureCompletePersistedHistory(): void {
    this.assertTranscriptViewAvailable();
    if (!this.persistenceTarget || !this.boundedContextIncomplete) {
      return;
    }
    const limits = this.boundedContextLimits;
    this.boundedContextLimits = undefined;
    this.setSessionTarget(this.persistenceTarget);
    this.boundedContextLimits = limits;
  }

  protected setLoadedSessionTarget(
    target: SessionManagerPersistenceTarget | undefined,
    entries: FileEntry[],
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
      this.persistenceTarget = target ? { ...target } : undefined;
      this.initializeSession({ id: target?.sessionId });
      this.persistenceHeaderPending = target !== undefined;
      return;
    }
    const header = partitioned.fileEntries.find((entry) => entry.type === "session");
    if (target) {
      assertCurrentSessionTranscriptHeader(header);
    }
    this.persistenceHeaderPending = false;
    this.persistenceTarget = target ? { ...target } : undefined;
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
  protected captureTranscriptView() {
    this.assertTranscriptViewAvailable();
    return {
      sessionId: this.sessionId,
      transcriptVersion: this.transcriptVersion,
      migrated: this.migrated,
      fileEntries: this.fileEntries,
      opaqueFileEntries: this.opaqueFileEntries,
      byId: this.byId,
      opaqueParentsById: this.opaqueParentsById,
      logicalParentsById: this.logicalParentsById,
      invalidLeafControlIds: this.invalidLeafControlIds,
      labelsById: this.labelsById,
      labelTimestampsById: this.labelTimestampsById,
      boundedFirstKeptById: this.boundedFirstKeptById,
      boundedParentIds: this.boundedParentIds,
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

  reloadPersistedTranscript(): void {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget) {
      const runtimeCwd = this.cwd;
      this.setSessionTarget(this.persistenceTarget);
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
  ): void {
    const target = this.persistenceTarget;
    if (!target) {
      return;
    }
    const runtimeCwd = this.cwd;
    const previousView = append ? structuredClone(this.captureTranscriptView()) : undefined;
    let reloaded = false;
    try {
      if (prepared.kind === "bounded") {
        const bounded = prepared.snapshot;
        // SAFETY: SQLite transcript readers return the same persisted entry union used by SessionManager.
        const entries = bounded.events as FileEntry[];
        if (
          append &&
          bounded.transcriptMutationAt !== append.expectedMutationAt &&
          !entries.some(
            (entry) => isIndexedSessionEntry(entry) && entry.id === append.expectedEntryId,
          )
        ) {
          throw new Error("SQLite transcript changed before adopting the committed append");
        }
        this.boundedContextIncomplete = true;
        this.persistedBoundaryCount = bounded.boundaryCount;
        this.persistedSuffixStartSeq = bounded.persistedSuffixStartSeq;
        this.transcriptMutationAt = bounded.transcriptMutationAt;
        this.setLoadedSessionTarget(target, entries, bounded);
        reloaded = true;
      } else {
        const snapshot = prepared.snapshot;
        // SAFETY: SQLite transcript readers return the same persisted entry union used by SessionManager.
        const entries = snapshot.events as FileEntry[];
        if (
          append &&
          snapshot.version.updatedAt !== append.expectedMutationAt &&
          !entries.some(
            (entry) => isIndexedSessionEntry(entry) && entry.id === append.expectedEntryId,
          )
        ) {
          throw new Error("SQLite transcript changed before adopting the committed append");
        }
        this.transcriptMutationAt = snapshot.version.updatedAt;
        this.setLoadedSessionTarget(target, entries, undefined, snapshot.version);
        reloaded = true;
      }
      if (!append) {
        return;
      }
      const activeBranch = this.getBranch();
      const admittedUserIndex = activeBranch.findIndex(
        (entry) => entry.id === append.admittedUserId,
      );
      const activeBranchHasNewerUser =
        admittedUserIndex < 0 ||
        activeBranch
          .slice(admittedUserIndex + 1)
          .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (activeBranchHasNewerUser) {
        this.adoptSelectedTranscriptPath(
          append.expectedEntryId,
          [...this.byId].map(([id, entry]) => [id, entry.parentId]),
        );
      }
    } catch (error) {
      if (reloaded && previousView) {
        Object.assign(this, previousView);
      }
      throw error;
    } finally {
      this.cwd = runtimeCwd;
    }
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
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.opaqueFileEntries = [];
    this.byId.clear();
    this.opaqueParentsById.clear();
    this.boundedFirstKeptById.clear();
    this.boundedParentIds.clear();
    this.logicalParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
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
    if (!this.opaqueParentsById.has(branchFromId)) {
      return undefined;
    }
    return this.resolveCanonicalParentId(branchFromId);
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
      if (parentId === null || parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
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

  /** No buffered writes remain here; asynchronous metadata methods own their settlement. */
  protected flushPendingPersistence(): void {}

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
    return this.persistenceTarget ? { ...this.persistenceTarget } : undefined;
  }
}
