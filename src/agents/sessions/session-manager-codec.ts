import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { stripCompactionReplayCheckpointInPlace } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import { bindCacheTtlProjectionPrefixes } from "../../config/sessions/session-cache-ttl-prefix.js";
import {
  isIndexedSessionEntry,
  partitionSessionFileEntries,
} from "../../config/sessions/session-entry-codec.js";
import { cloneTranscriptView } from "../../config/sessions/transcript-snapshot.js";
import { selectSessionTranscriptLeafControlledPath } from "../../config/sessions/transcript-tree.js";
import { MIN_READABLE_SESSION_VERSION } from "../../config/sessions/version.js";
import { logWarn } from "../../logger.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { projectModelContextMessages } from "../../shared/model-context-message.js";
import { isOpenClawSubagentCompletionMirrorAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import type { SessionTreeEntry as CoreSessionTreeEntry } from "../runtime/index.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import type {
  CompactionEntry,
  FileEntry,
  SessionContext,
  SessionEntry,
  PreservedOpaqueFileEntry,
  SessionTreeNode,
} from "./session-manager-types.js";
import type { SessionManagerBoundedView } from "./session-manager-view-types.js";
import { shareSessionSystemPrompt } from "./system-prompt-pool.js";

export {
  classifySessionFileEntry,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "../../config/sessions/session-entry-codec.js";

/** Hydrated entries own envelopes; writable SDK exposure detaches their shared payloads once. */
export function prepareSessionManagerEntries(entries: readonly unknown[]) {
  const partitioned = partitionSessionFileEntries(entries);
  const pendingWritableTranscriptEntries = new Set<object>();
  const ownEnvelope = <T>(
    entry: T,
    shared = Object.isFrozen(entries) || Object.isFrozen(entry),
  ): T => {
    if (!entry || typeof entry !== "object" || !shared) {
      return entry;
    }
    const container: object = Array.isArray(entry) ? entry.slice() : {};
    const envelope = Object.assign(container, freezeJsonSnapshot(entry));
    pendingWritableTranscriptEntries.add(envelope);
    return envelope;
  };
  let fileIndex = 0;
  for (const [index, entry] of partitioned.fileEntriesByOriginalIndex.entries()) {
    if (entry) {
      const envelope = ownEnvelope(
        shareSessionSystemPrompt(entry),
        Object.isFrozen(entries) || Object.isFrozen(entry),
      );
      partitioned.fileEntries[fileIndex++] = envelope;
      partitioned.fileEntriesByOriginalIndex[index] = envelope;
    }
  }
  if (
    (partitioned.fileEntries.find((entry) => entry.type === "session")?.version ?? 1) <
    MIN_READABLE_SESSION_VERSION
  ) {
    ownSessionTranscriptEntries(partitioned.fileEntries, pendingWritableTranscriptEntries);
  }
  for (const entry of partitioned.opaqueEntries) {
    entry.record = ownEnvelope(entry.record);
  }
  return { ...partitioned, pendingWritableTranscriptEntries };
}

export function ownSessionTranscriptEntries(
  entries: readonly unknown[],
  pending: Set<object>,
): boolean {
  let detached = false;
  for (const entry of entries) {
    if (entry && typeof entry === "object" && pending.has(entry)) {
      Object.assign(entry, cloneTranscriptView(entry, { shareImmutablePayloads: false }));
      pending.delete(entry);
      detached = true;
    }
  }
  return detached;
}

export function prepareSessionManagerBoundedIndexes(
  bounded: SessionManagerBoundedView,
  entriesByOriginalIndex: readonly (FileEntry | undefined)[],
  readBranch: () => readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
) {
  const boundedFirstKeptById = new Map<string, string>();
  for (const [boundaryId, range] of bounded.firstKeptRanges) {
    // An empty retained slice starts at its boundary; opaque rows are not model cut points.
    let firstKeptEntryId = boundaryId;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const entry = entriesByOriginalIndex[index];
      if (isIndexedSessionEntry(entry)) {
        firstKeptEntryId = entry.id;
        break;
      }
    }
    boundedFirstKeptById.set(boundaryId, firstKeptEntryId);
  }
  const cacheTtlProjectionPrefixes = bindCacheTtlProjectionPrefixes(bounded, {
    getBranch: readBranch,
    getEntry: (id) => byId.get(id),
  });
  return { boundedFirstKeptById, cacheTtlProjectionPrefixes };
}

export function interleaveSessionFileEntries(
  fileEntries: FileEntry[],
  opaqueEntries: PreservedOpaqueFileEntry[],
): unknown[] {
  const entries: unknown[] = [];
  let opaqueIndex = 0;
  for (let index = 0; index <= fileEntries.length; index++) {
    while (opaqueEntries[opaqueIndex]?.index === index) {
      entries.push(opaqueEntries[opaqueIndex++]?.record);
    }
    if (fileEntries[index]) {
      entries.push(fileEntries[index]);
    }
  }
  while (opaqueIndex < opaqueEntries.length) {
    entries.push(opaqueEntries[opaqueIndex++]?.record);
  }
  return entries;
}

export function clampOpaqueSessionEntryIndexes(
  entries: PreservedOpaqueFileEntry[],
  length: number,
): void {
  let previous = 0;
  for (const entry of entries) {
    entry.index = Math.max(previous, Math.min(entry.index, length));
    previous = entry.index;
  }
}

export function collectSessionEntryChildren(
  entries: Iterable<SessionEntry>,
  parentId: string,
  normalize: (entry: SessionEntry) => SessionEntry,
): SessionEntry[] {
  const children: SessionEntry[] = [];
  for (const entry of entries) {
    const normalized = normalize(entry);
    if (normalized.parentId === parentId) {
      children.push(normalized);
    }
  }
  return children;
}

/** Rows that record history without consuming the open turn's keyed input. */
export function isOutOfTurnHistoryEntry(entry: SessionEntry): boolean {
  return (
    isTalkRealtimeVoiceEntry(entry) ||
    (entry.type === "message" && isOpenClawSubagentCompletionMirrorAssistantMessage(entry.message))
  );
}

function isTalkRealtimeVoiceEntry(entry: SessionEntry): boolean {
  if (
    entry.type !== "message" ||
    (entry.message.role !== "user" && entry.message.role !== "assistant")
  ) {
    return false;
  }
  const provenance: unknown = Reflect.get(entry.message, "provenance");
  return (
    isRecord(provenance) &&
    provenance.kind === "realtime_voice" &&
    provenance.sourceChannel === "talk"
  );
}

export function isSessionContextMetadataEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "thinking_level_change" ||
    entry.type === "model_change" ||
    entry.type === "custom" ||
    entry.type === "label" ||
    entry.type === "session_info"
  );
}

export type SessionFileEntryMigrationState = {
  createEntryId: (originalIndex: number) => string;
  previousId: string | null;
  resolveOriginalEntryId?: (originalIndex: number) => string | undefined;
  sourceVersion: number;
};

export function migrateSessionFileEntryToCurrentVersion(
  entry: FileEntry,
  originalIndex: number,
  state: SessionFileEntryMigrationState,
): void {
  if (state.sourceVersion < 2) {
    if (entry.type === "session") {
      entry.version = 2;
    } else {
      entry.id = state.createEntryId(originalIndex);
      entry.parentId = state.previousId;
      state.previousId = entry.id;

      if (entry.type === "compaction") {
        const compaction = entry as CompactionEntry & { firstKeptEntryIndex?: number };
        if (typeof compaction.firstKeptEntryIndex === "number") {
          const firstKeptEntryId = state.resolveOriginalEntryId?.(compaction.firstKeptEntryIndex);
          if (firstKeptEntryId) {
            compaction.firstKeptEntryId = firstKeptEntryId;
          }
          delete compaction.firstKeptEntryIndex;
        }
      }
    }
  }

  if (state.sourceVersion < 3) {
    if (entry.type === "session") {
      entry.version = 3;
    } else if (entry.type === "message" && entry.message) {
      const message = entry.message as { role: string; customType?: string };
      if (message.role === "hookMessage") {
        message.role = "custom";
        message.customType ||= "hook";
      }
    }
  }
}

export function migrateToCurrentVersion(
  entries: FileEntry[],
  entriesByOriginalIndex?: readonly (FileEntry | undefined)[],
): boolean {
  const header = entries.find((entry) => entry.type === "session");
  const version = header?.version ?? 1;
  if (version >= MIN_READABLE_SESSION_VERSION) {
    return false;
  }
  const state: SessionFileEntryMigrationState = {
    createEntryId: generateSessionEntryId,
    previousId: null,
    resolveOriginalEntryId: (originalIndex) => {
      const targetEntry = entriesByOriginalIndex
        ? entriesByOriginalIndex[originalIndex]
        : entries[originalIndex];
      return targetEntry && targetEntry.type !== "session" ? targetEntry.id : undefined;
    },
    sourceVersion: version,
  };
  for (const [index, entry] of entries.entries()) {
    migrateSessionFileEntryToCurrentVersion(entry, index, state);
  }
  return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
  migrateToCurrentVersion(entries);
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  const boundary = entries.findLast(
    (entry) => entry.type === "reset" || entry.type === "compaction",
  );
  return boundary?.type === "compaction" ? boundary : null;
}

export function projectSessionModelContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  // Stored snapshots stay shared; mutable SDK edits detach before internal publication.
  const events = [...branch];
  for (let index = 0; index < events.length; index++) {
    const entry = events[index]!;
    if (entry.type === "message") {
      const message = projectModelContextMessages([entry.message])[0]!;
      if (message !== entry.message) {
        events[index] = { ...entry, message };
      }
    }
  }
  return freezeJsonSnapshot(cloneTranscriptView(events));
}

/** Reuse immutable text without sharing the freshly hydrated message containers. */
export function reuseResidentSessionEntryStrings(
  entries: readonly FileEntry[],
  residentEntries: ReadonlyMap<string, SessionEntry>,
): void {
  const reuse = (target: object, source: unknown): void => {
    if (target === source || source === null || typeof source !== "object" || isProxy(source)) {
      return;
    }
    for (const key of Object.keys(target)) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "string" && (value === null || typeof value !== "object")) {
        continue;
      }
      const resident: unknown = Object.getOwnPropertyDescriptor(source, key)?.value;
      if (typeof value === "string" && value === resident) {
        Reflect.set(target, key, resident);
      } else if (value !== null && typeof value === "object") {
        reuse(value, resident);
      }
    }
  };
  for (const entry of entries) {
    const resident = entry.type === "message" && residentEntries.get(entry.id);
    if (!resident || isProxy(resident) || entry.type !== "message") {
      continue;
    }
    if (entry.message === Object.getOwnPropertyDescriptor(resident, "message")?.value) {
      continue;
    }
    // Fresh reloads own their string replacement; retained immutable payloads already share it.
    if (Object.isFrozen(entry.message)) {
      entry.message = cloneTranscriptView(entry.message, { shareImmutablePayloads: false });
    }
    reuse(entry, resident);
  }
}

export function buildInitialContext(
  branch: SessionEntry[],
  residentEntries?: ReadonlyMap<string, SessionEntry>,
): SessionContext {
  if (residentEntries) {
    reuseResidentSessionEntryStrings(branch, residentEntries);
  }
  return buildCoreSessionContext(projectSessionModelContextEntries(branch));
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byIdInput?: Map<string, SessionEntry>,
): SessionContext {
  let contextEntries = entries;
  let contextById = byIdInput;
  if (leafId === undefined) {
    const selectedEntries = selectSessionTranscriptLeafControlledPath(entries);
    if (selectedEntries !== undefined) {
      contextEntries = selectedEntries;
      contextById = undefined;
    }
  }

  const byId = contextById ?? new Map(contextEntries.map((entry) => [entry.id, entry]));

  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }
  let leaf = leafId ? byId.get(leafId) : undefined;
  leaf ??= contextEntries.at(-1);
  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return buildCoreSessionContext(path as CoreSessionTreeEntry[]) as SessionContext;
}

export function buildSessionTree(
  entries: readonly SessionEntry[],
  labelsById: ReadonlyMap<string, string>,
  labelTimestampsById: ReadonlyMap<string, SessionEntry["timestamp"]>,
  resolveParentId: (parentId: string | null) => string | null,
): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, {
      entry,
      children: [],
      label: labelsById.get(entry.id),
      labelTimestamp: labelTimestampsById.get(entry.id),
    });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    const parentId = resolveParentId(entry.parentId);
    const parent = parentId !== null && parentId !== entry.id ? nodeMap.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodeMap.values()) {
    node.children.sort(
      (left, right) =>
        new Date(left.entry.timestamp).getTime() - new Date(right.entry.timestamp).getTime(),
    );
  }
  return roots;
}

export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let skipped = 0;
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(normalizeLoadedFileEntry(JSON.parse(line) as FileEntry));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    logWarn(
      `parseJsonlEntries: skipped ${skipped} malformed JSONL line(s) — ` +
        `${entries.length} valid entries were loaded`,
    );
  }
  return entries;
}

export function normalizeLoadedFileEntry(entry: FileEntry): FileEntry {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return entry;
  }
  const message: Record<string, unknown> = entry.message;
  if (
    (message.role === "assistant" || message.role === "toolResult") &&
    typeof message.content === "string"
  ) {
    message.content = [{ type: "text", text: message.content }];
    stripCompactionReplayCheckpointInPlace(message);
  } else if (message.role === "toolResult" && isRecord(message.content)) {
    message.content = [message.content];
  }
  return entry;
}
