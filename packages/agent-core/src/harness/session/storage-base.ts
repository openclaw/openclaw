// Agent Core module implements storage base behavior.
import {
  type LeafEntry,
  SessionError,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "../types.js";
import { uuidv7 } from "./uuid.js";

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
  if (entry.type !== "label") {
    return;
  }
  const label = entry.label?.trim();
  if (label) {
    labelsById.set(entry.targetId, label);
  } else {
    labelsById.delete(entry.targetId);
  }
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
  const labelsById = new Map<string, string>();
  for (const entry of entries) {
    updateLabelCache(labelsById, entry);
  }
  return labelsById;
}

function isSideAppendEntry(entry: SessionTreeEntry): boolean {
  return entry.appendMode === "side";
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = uuidv7().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return uuidv7();
}

/** Return the visible-leaf update represented by one session tree entry. */
export function leafIdUpdateAfterEntry(entry: SessionTreeEntry): string | null | undefined {
  if (entry.type !== "leaf" && isSideAppendEntry(entry)) {
    return undefined;
  }
  switch (entry.type) {
    case "leaf":
      return entry.targetId;
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return entry.id;
    default:
      // JSONL transcripts may contain parent-linked plugin rows that advance
      // the raw append cursor without selecting a model-visible branch.
      return undefined;
  }
}

/** Return the raw parent for the next append after applying a tree entry. */
export function appendParentIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf"
    ? entry.appendParentId === undefined
      ? entry.targetId
      : entry.appendParentId
    : entry.id;
}

function resolveLeafId(entries: readonly SessionTreeEntry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) {
    const update = leafIdUpdateAfterEntry(entry);
    if (update !== undefined) {
      leafId = update;
    }
  }
  return leafId;
}

function resolveAppendParentId(entries: readonly SessionTreeEntry[]): string | null {
  let appendParentId: string | null = null;
  for (const entry of entries) {
    appendParentId = appendParentIdAfterEntry(entry);
  }
  return appendParentId;
}

function buildLogicalParentsById(entries: readonly SessionTreeEntry[]): Map<string, string | null> {
  const logicalParentsById = new Map<string, string | null>();
  let leafId: string | null = null;
  let appendParentId: string | null = null;
  for (const entry of entries) {
    const leafUpdate = leafIdUpdateAfterEntry(entry);
    if (
      leafUpdate === entry.id &&
      !isSideAppendEntry(entry) &&
      entry.parentId === appendParentId &&
      leafId !== appendParentId
    ) {
      logicalParentsById.set(entry.id, leafId);
    }
    if (leafUpdate !== undefined) {
      leafId = leafUpdate;
    }
    appendParentId = appendParentIdAfterEntry(entry);
  }
  return logicalParentsById;
}

export abstract class BaseSessionStorage<
  TMetadata extends SessionMetadata = SessionMetadata,
> implements SessionStorage<TMetadata> {
  private readonly metadata: TMetadata;
  private readonly entries: SessionTreeEntry[];
  private readonly byId: Map<string, SessionTreeEntry>;
  private readonly labelsById: Map<string, string>;
  private readonly logicalParentsById: Map<string, string | null>;
  private leafId: string | null;
  private appendParentId: string | null;

  protected constructor(
    metadata: TMetadata,
    entries: SessionTreeEntry[],
    leafId: string | null = resolveLeafId(entries),
    appendParentId: string | null = resolveAppendParentId(entries),
  ) {
    this.metadata = metadata;
    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.labelsById = buildLabelsById(entries);
    this.logicalParentsById = buildLogicalParentsById(entries);
    this.leafId = leafId;
    this.appendParentId = appendParentId;
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
    if (this.appendParentId !== null && !this.byId.has(this.appendParentId)) {
      throw new SessionError("invalid_session", `Append parent ${this.appendParentId} not found`);
    }
  }

  async getMetadata(): Promise<TMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
    return this.leafId;
  }

  async getAppendParentId(): Promise<string | null> {
    if (this.appendParentId !== null && !this.byId.has(this.appendParentId)) {
      throw new SessionError("invalid_session", `Append parent ${this.appendParentId} not found`);
    }
    return this.appendParentId;
  }

  protected createLeafEntry(leafId: string | null): LeafEntry {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    return {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.appendParentId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  protected validateEntryForAppend(entry: SessionTreeEntry): void {
    const leafId = leafIdUpdateAfterEntry(entry);
    const leafIsNewEntry = entry.type !== "leaf" && leafId === entry.id;
    if (leafId !== undefined && leafId !== null && !leafIsNewEntry && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }

    const appendParentId = appendParentIdAfterEntry(entry);
    const appendParentIsNewEntry = entry.type !== "leaf" && appendParentId === entry.id;
    if (appendParentId !== null && !appendParentIsNewEntry && !this.byId.has(appendParentId)) {
      throw new SessionError("not_found", `Append parent ${appendParentId} not found`);
    }
  }

  protected recordEntry(entry: SessionTreeEntry): void {
    // Leaf and label entries are append-only state changes; keep derived indexes
    // synchronized here so memory and JSONL storage expose identical behavior.
    this.validateEntryForAppend(entry);
    const leafId = leafIdUpdateAfterEntry(entry);
    if (
      leafId === entry.id &&
      !isSideAppendEntry(entry) &&
      entry.parentId === this.appendParentId &&
      this.leafId !== this.appendParentId
    ) {
      this.logicalParentsById.set(entry.id, this.leafId);
    }
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    updateLabelCache(this.labelsById, entry);
    if (leafId !== undefined) {
      this.leafId = leafId;
    }
    this.appendParentId = appendParentIdAfterEntry(entry);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.byId.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries.filter(
      (entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) {
      return [];
    }
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) {
        throw new SessionError("invalid_session", `Cycle found at entry ${current.id}`);
      }
      seen.add(current.id);
      if (current.type !== "leaf") {
        path.unshift(current);
      }
      // Leaf rows are control records. Descendants written by older appenders
      // may point at the marker, but their visible ancestry starts at its target.
      const parentId =
        current.type === "leaf"
          ? current.targetId
          : this.logicalParentsById.has(current.id)
            ? (this.logicalParentsById.get(current.id) ?? null)
            : current.parentId;
      if (!parentId) {
        break;
      }
      const parent = this.byId.get(parentId);
      if (!parent) {
        throw new SessionError("invalid_session", `Entry ${parentId} not found`);
      }
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.entries];
  }

  abstract setLeafId(leafId: string | null): Promise<void>;
  abstract appendEntry(entry: SessionTreeEntry): Promise<void>;
}
