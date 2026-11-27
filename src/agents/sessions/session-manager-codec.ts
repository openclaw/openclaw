import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildSessionContext as buildCoreSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { stripCompactionReplayCheckpointInPlace } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import { bindCacheTtlProjectionPrefixes } from "../../config/sessions/session-cache-ttl-prefix.js";
import {
  isIndexedSessionEntry,
  partitionSessionFileEntries,
} from "../../config/sessions/session-entry-codec.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { cloneTranscriptView } from "../../config/sessions/transcript-snapshot.js";
import { selectSessionTranscriptLeafControlledPath } from "../../config/sessions/transcript-tree.js";
import { MIN_READABLE_SESSION_VERSION } from "../../config/sessions/version.js";
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
  const ownerSealed = isOwnedTranscriptPayload(entries);
  const pendingWritableTranscriptEntries = new Set<object>();
  // Probe the root once: JavaScriptCore scans every index of an array on each
  // Object.isFrozen call, so a per-entry probe is quadratic in history length.
  const entriesFrozen = Object.isFrozen(entries);
  const ownEnvelope = <T>(entry: T, shared = entriesFrozen || Object.isFrozen(entry)): T => {
    if (!entry || typeof entry !== "object" || !shared) {
      return entry;
    }
    const container: object = Array.isArray(entry) ? entry.slice() : {};
    // Hydration's sealed root outlives the generic freezer's rotating memo.
    const envelope = Object.assign(container, ownerSealed ? entry : freezeJsonSnapshot(entry));
    pendingWritableTranscriptEntries.add(envelope);
    return envelope;
  };
  let fileIndex = 0;
  for (const [index, entry] of partitioned.fileEntriesByOriginalIndex.entries()) {
    if (entry) {
      const envelope = ownEnvelope(
        shareSessionSystemPrompt(entry),
        entriesFrozen || Object.isFrozen(entry),
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

/** Data projection only; an exclusive preparation worker does not publish a shared snapshot. */
export function projectSessionModelContextData(branch: readonly SessionEntry[]): SessionEntry[] {
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
  return events;
}

export function projectSessionModelContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  // Stored snapshots stay shared; mutable SDK edits detach before internal publication.
  return cloneTranscriptView(projectSessionModelContextData(branch), { freeze: true });
}

/** Reuse sealed messages or immutable text; writable SDK messages stay detached. */
export function reuseResidentSessionEntryStrings(
  entries: readonly FileEntry[],
  residentEntries: ReadonlyMap<string, SessionEntry>,
): void {
  // Admitted payloads are JSON. Preserve property order as well as values so reusing
  // a sealed resident message also preserves the incoming serialized bytes.
  const samePayload = <T>(left: T, right: unknown): right is T => {
    if (Object.is(left, right)) {
      return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
      return false;
    }
    const keys = Object.keys(left);
    const otherKeys = Object.keys(right);
    return (
      Array.isArray(left) === Array.isArray(right) &&
      keys.length === otherKeys.length &&
      keys.every(
        (key, index) =>
          key === otherKeys[index] && samePayload(Reflect.get(left, key), Reflect.get(right, key)),
      )
    );
  };
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
    const residentMessage: unknown = Object.getOwnPropertyDescriptor(resident, "message")?.value;
    if (entry.message === residentMessage) {
      continue;
    }
    if (
      isOwnedTranscriptPayload(entry.message) &&
      residentMessage !== null &&
      typeof residentMessage === "object" &&
      isOwnedTranscriptPayload(residentMessage) &&
      samePayload(entry.message, residentMessage)
    ) {
      entry.message = residentMessage;
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
  restore: (entries: SessionEntry[]) => SessionContext = buildCoreSessionContext,
): SessionContext {
  if (residentEntries) {
    reuseResidentSessionEntryStrings(branch, residentEntries);
  }
  return restore(projectSessionModelContextEntries(branch));
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
