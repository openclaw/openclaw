import {
  SessionManager,
  type CompactionEntry,
  type CustomEntry,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_IN_MEMORY_FILE_ENTRIES = 2000;
const MIN_MAX_IN_MEMORY_FILE_ENTRIES = 256;
const PATCHED_SYMBOL = Symbol.for("openclaw.pi-session-manager-memory-bound");

type LabelEntryLike = SessionEntry & {
  type: "label";
  targetId: string;
  label?: string;
};

type MutableSessionManager = {
  fileEntries?: FileEntry[];
  byId?: Map<string, SessionEntry>;
  labelsById?: Map<string, string>;
  labelTimestampsById?: Map<string, string>;
  _buildIndex?: () => void;
  getBranch: SessionManager["getBranch"];
  getLeafId: SessionManager["getLeafId"];
};

type SessionManagerPrototype = {
  _appendEntry?: (entry: SessionEntry) => void;
  setSessionFile?: (sessionFile: string) => void;
  [PATCHED_SYMBOL]?: boolean;
};

type RetainedLabel = {
  label: string;
  timestamp?: string;
};

function resolveMaxInMemoryFileEntries(): number {
  const configured = Number.parseInt(
    process.env.PI_SESSION_MANAGER_MAX_IN_MEMORY_ENTRIES ?? "",
    10,
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(configured, MIN_MAX_IN_MEMORY_FILE_ENTRIES);
  }
  return DEFAULT_MAX_IN_MEMORY_FILE_ENTRIES;
}

function cloneEntryWithParent<T extends SessionEntry>(entry: T, parentId: string | null): T {
  return { ...entry, parentId };
}

function collectLatestPreCompactionState(entries: SessionEntry[]): SessionEntry[] {
  const latestByKey = new Map<string, SessionEntry>();

  for (const entry of entries) {
    switch (entry.type) {
      case "thinking_level_change":
      case "model_change":
      case "session_info":
        latestByKey.set(entry.type, entry);
        break;
      case "custom":
        latestByKey.set(`custom:${(entry as CustomEntry).customType}`, entry);
        break;
      default:
        break;
    }
  }

  return entries.filter((entry) => latestByKey.get(stateEntryKey(entry))?.id === entry.id);
}

function stateEntryKey(entry: SessionEntry): string {
  if (entry.type === "custom") {
    return `custom:${(entry as CustomEntry).customType}`;
  }
  return entry.type;
}

function findLatestCompaction(entries: SessionEntry[]): CompactionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") {
      return entry as CompactionEntry;
    }
  }
  return undefined;
}

function collectRetainedLabels(
  manager: MutableSessionManager,
  retainedEntryIds: Set<string>,
): Map<string, RetainedLabel> {
  const labels = new Map<string, RetainedLabel>();

  for (const targetId of retainedEntryIds) {
    const label = manager.labelsById?.get(targetId);
    if (label === undefined) {
      continue;
    }
    labels.set(targetId, {
      label,
      timestamp: manager.labelTimestampsById?.get(targetId),
    });
  }

  for (const entry of manager.fileEntries ?? []) {
    if (entry.type !== "label") {
      continue;
    }
    const labelEntry = entry as LabelEntryLike;
    if (!retainedEntryIds.has(labelEntry.targetId)) {
      continue;
    }
    if (labelEntry.label) {
      labels.set(labelEntry.targetId, {
        label: labelEntry.label,
        timestamp: labelEntry.timestamp,
      });
    } else {
      labels.delete(labelEntry.targetId);
    }
  }

  return labels;
}

function restoreRetainedLabels(
  manager: MutableSessionManager,
  labels: Map<string, RetainedLabel>,
): void {
  for (const [targetId, label] of labels) {
    manager.labelsById?.set(targetId, label.label);
    if (label.timestamp) {
      manager.labelTimestampsById?.set(targetId, label.timestamp);
    }
  }
}

function pruneInMemoryEntriesIfNeeded(manager: MutableSessionManager): void {
  const fileEntries = manager.fileEntries;
  if (!fileEntries || fileEntries.length <= resolveMaxInMemoryFileEntries()) {
    return;
  }

  const leafId = manager.getLeafId();
  if (!leafId) {
    return;
  }

  const branch = manager.getBranch(leafId);
  const latestCompaction = findLatestCompaction(branch);
  if (!latestCompaction) {
    return;
  }

  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === latestCompaction.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) {
    return;
  }

  const header = fileEntries.find((entry) => entry.type === "session");
  if (!header) {
    return;
  }

  const retainedPath = branch.slice(firstKeptIndex);
  const preCompactionState = collectLatestPreCompactionState(branch.slice(0, firstKeptIndex));
  const retainedIds = new Set<string>([
    ...preCompactionState.map((entry) => entry.id),
    ...retainedPath.map((entry) => entry.id),
  ]);
  const retainedLabels = collectRetainedLabels(manager, retainedIds);
  const prunedEntries: FileEntry[] = [header];
  let parentId: string | null = null;

  for (const entry of preCompactionState) {
    prunedEntries.push(cloneEntryWithParent(entry, parentId));
    parentId = entry.id;
  }

  for (const entry of retainedPath) {
    const nextParentId = retainedIds.has(entry.parentId ?? "") ? entry.parentId : parentId;
    prunedEntries.push(cloneEntryWithParent(entry, nextParentId ?? null));
    parentId = entry.id;
  }

  if (prunedEntries.length >= fileEntries.length) {
    return;
  }

  manager.fileEntries = prunedEntries;
  manager._buildIndex?.();
  restoreRetainedLabels(manager, retainedLabels);
}

export function installPiSessionManagerMemoryBound(): void {
  const prototype = SessionManager.prototype as unknown as SessionManagerPrototype;
  if (prototype[PATCHED_SYMBOL]) {
    return;
  }

  const originalAppendEntry = prototype._appendEntry;
  if (originalAppendEntry) {
    prototype._appendEntry = function appendEntryWithMemoryBound(
      this: MutableSessionManager,
      entry: SessionEntry,
    ) {
      originalAppendEntry.call(this, entry);
      pruneInMemoryEntriesIfNeeded(this);
    };
  }

  const originalSetSessionFile = prototype.setSessionFile;
  if (originalSetSessionFile) {
    prototype.setSessionFile = function setSessionFileWithMemoryBound(
      this: MutableSessionManager,
      sessionFile: string,
    ) {
      originalSetSessionFile.call(this, sessionFile);
      pruneInMemoryEntriesIfNeeded(this);
    };
  }

  prototype[PATCHED_SYMBOL] = true;
}

installPiSessionManagerMemoryBound();

export { SessionManager };
