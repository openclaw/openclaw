import {
  resolveOpaqueSessionFirstKeptEntryId,
  SessionEntryNavigation,
} from "../../config/sessions/session-entry-navigation.js";
import {
  isIndexedSessionEntry,
  migrateToCurrentVersion,
  prepareSessionManagerEntries,
  prepareSessionManagerBoundedIndexes,
} from "./session-manager-codec.js";
import type { FileEntry, PreservedOpaqueFileEntry, SessionEntry } from "./session-manager-types.js";
import type { SessionManagerBoundedView } from "./session-manager-view-types.js";

/** Transcript navigation shared by host managers and read-only preparation workers. */
export class SessionManagerNavigation extends SessionEntryNavigation<SessionEntry> {
  migrated = false;
  protected fileEntries: FileEntry[] = [];
  protected opaqueFileEntries: PreservedOpaqueFileEntry[] = [];
  protected boundedFirstKeptById = new Map<string, string>();
  protected pendingDeliberateAppend = false;

  constructor(input?: { events: readonly unknown[]; bounded: SessionManagerBoundedView }) {
    super();
    if (!input) {
      return;
    }
    const { events, bounded } = input;
    const partitioned = prepareSessionManagerEntries(events);
    this.fileEntries = partitioned.fileEntries;
    this.opaqueFileEntries = partitioned.opaqueEntries;
    this.migrated = migrateToCurrentVersion(
      this.fileEntries,
      partitioned.fileEntriesByOriginalIndex,
    );
    this.buildIndex();
    for (const [id, parentId] of bounded.opaqueParents) {
      this.opaqueParentsById.set(id, parentId);
    }
    this.adoptSelectedTranscriptPath(bounded.activeLeafEntryId, bounded.parents);
    this.boundedFirstKeptById = prepareSessionManagerBoundedIndexes(
      bounded,
      partitioned.fileEntriesByOriginalIndex,
      () => this.getBranch(),
      this.byId,
    ).boundedFirstKeptById;
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
}
