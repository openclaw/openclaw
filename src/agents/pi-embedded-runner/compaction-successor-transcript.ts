import { randomUUID } from "node:crypto";
import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
} from "../../config/sessions.js";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  CURRENT_SESSION_VERSION,
  type CompactionEntry,
  type SessionEntry,
  type SessionHeader,
  migrateSessionEntries,
} from "../transcript/session-transcript-contract.js";
import { TranscriptState } from "../transcript/transcript-state.js";
import { collectDuplicateUserMessageEntryIdsForCompaction } from "./compaction-duplicate-user-messages.js";

type ReadonlySessionManagerForRotation = Pick<
  TranscriptState,
  "buildSessionContext" | "getBranch" | "getCwd" | "getEntries" | "getHeader"
>;

export type CompactionTranscriptRotation = {
  rotated: boolean;
  reason?: string;
  sessionId?: string;
  transcriptPath?: string;
  /** Compatibility metadata for callers that still surface `sessionFile`. */
  sessionFile?: string;
  compactionEntryId?: string;
  leafId?: string;
  entriesWritten?: number;
};

export function shouldRotateCompactionTranscript(config?: OpenClawConfig): boolean {
  return config?.agents?.defaults?.compaction?.truncateAfterCompaction === true;
}

export async function rotateTranscriptAfterCompaction(params: {
  sessionManager: ReadonlySessionManagerForRotation;
  agentId?: string;
  sessionFile: string;
  now?: () => Date;
}): Promise<CompactionTranscriptRotation> {
  const transcriptLocator = params.sessionFile.trim();
  if (!transcriptLocator) {
    return { rotated: false, reason: "missing transcript locator" };
  }
  if (!isSqliteSessionTranscriptLocator(transcriptLocator)) {
    return { rotated: false, reason: "transcript not in SQLite" };
  }

  const branch = params.sessionManager.getBranch();
  const latestCompactionIndex = findLatestCompactionIndex(branch);
  if (latestCompactionIndex < 0) {
    return { rotated: false, reason: "no compaction entry" };
  }

  const compaction = branch[latestCompactionIndex] as CompactionEntry;
  const timestamp = (params.now?.() ?? new Date()).toISOString();
  const sessionId = randomUUID();
  const sourceScope = resolveSourceTranscriptScope({
    agentId: params.agentId,
    transcriptPath: transcriptLocator,
  });
  const successorTranscriptPath = resolveSuccessorTranscriptPath({
    transcriptPath: transcriptLocator,
    sessionId,
    agentId: sourceScope.agentId,
  });
  const successorEntries = buildSuccessorEntries({
    allEntries: params.sessionManager.getEntries(),
    branch,
    latestCompactionIndex,
  });
  if (successorEntries.length === 0) {
    return { rotated: false, reason: "empty successor transcript" };
  }

  const header = buildSuccessorHeader({
    previousHeader: params.sessionManager.getHeader(),
    sessionId,
    timestamp,
    cwd: params.sessionManager.getCwd(),
    parentSession: transcriptLocator,
  });
  replaceSqliteSessionTranscriptEvents({
    agentId: sourceScope.agentId,
    sessionId,
    transcriptPath: successorTranscriptPath,
    events: [header, ...successorEntries],
  });
  new TranscriptState({ header, entries: successorEntries }).buildSessionContext();

  return {
    rotated: true,
    sessionId,
    transcriptPath: successorTranscriptPath,
    sessionFile: successorTranscriptPath,
    compactionEntryId: compaction.id,
    leafId: successorEntries[successorEntries.length - 1]?.id,
    entriesWritten: successorEntries.length,
  };
}

export async function rotateTranscriptFileAfterCompaction(params: {
  agentId?: string;
  sessionFile: string;
  now?: () => Date;
}): Promise<CompactionTranscriptRotation> {
  const state = loadTranscriptStateFromSqlite({
    agentId: params.agentId,
    transcriptPath: params.sessionFile,
  });
  if (!state) {
    return { rotated: false, reason: "transcript not in SQLite" };
  }
  return rotateTranscriptAfterCompaction({
    sessionManager: state,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    ...(params.now ? { now: params.now } : {}),
  });
}

function resolveAgentIdFromTranscriptPath(transcriptPath: string): string {
  void transcriptPath;
  return DEFAULT_AGENT_ID;
}

function resolveSourceTranscriptScope(params: { agentId?: string; transcriptPath: string }): {
  agentId: string;
} {
  if (params.agentId?.trim()) {
    return { agentId: normalizeAgentId(params.agentId) };
  }
  const existing = resolveSqliteSessionTranscriptScopeForPath({
    transcriptPath: params.transcriptPath,
  });
  return {
    agentId: existing?.agentId ?? resolveAgentIdFromTranscriptPath(params.transcriptPath),
  };
}

function loadTranscriptStateFromSqlite(params: {
  agentId?: string;
  transcriptPath: string;
}): TranscriptState | null {
  const scope = resolveSqliteSessionTranscriptScopeForPath({
    transcriptPath: params.transcriptPath,
  });
  const agentId = params.agentId?.trim()
    ? normalizeAgentId(params.agentId)
    : (scope?.agentId ?? resolveAgentIdFromTranscriptPath(params.transcriptPath));
  const sessionId = scope?.sessionId;
  if (!sessionId) {
    return null;
  }
  const events = loadSqliteSessionTranscriptEvents({ agentId, sessionId }).map(
    (entry) => entry.event,
  );
  if (events.length === 0) {
    return null;
  }
  const fileEntries = events.filter((event): event is SessionHeader | SessionEntry =>
    Boolean(event && typeof event === "object"),
  );
  migrateSessionEntries(fileEntries);
  const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
  return new TranscriptState({
    header: header ?? null,
    entries: fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session"),
  });
}

function findLatestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

function buildSuccessorEntries(params: {
  allEntries: SessionEntry[];
  branch: SessionEntry[];
  latestCompactionIndex: number;
}): SessionEntry[] {
  const { allEntries, branch, latestCompactionIndex } = params;
  const compaction = branch[latestCompactionIndex] as CompactionEntry;

  const summarizedBranchIds = new Set<string>();
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = branch[index];
    if (!entry) {
      continue;
    }
    if (compaction.firstKeptEntryId && entry.id === compaction.firstKeptEntryId) {
      break;
    }
    summarizedBranchIds.add(entry.id);
  }

  const latestStateEntryIds = collectLatestStateEntryIds(branch.slice(0, latestCompactionIndex));
  const staleStateEntryIds = new Set<string>();
  for (const entry of branch.slice(0, latestCompactionIndex)) {
    if (isDedupedStateEntry(entry) && !latestStateEntryIds.has(entry.id)) {
      staleStateEntryIds.add(entry.id);
    }
  }

  const removedIds = new Set<string>();
  const duplicateUserMessageIds = collectDuplicateUserMessageEntryIdsForCompaction(branch);
  for (const entry of allEntries) {
    if (
      (summarizedBranchIds.has(entry.id) && entry.type === "message") ||
      staleStateEntryIds.has(entry.id) ||
      duplicateUserMessageIds.has(entry.id)
    ) {
      removedIds.add(entry.id);
    }
  }
  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
    }
  }

  const entryById = new Map<string, SessionEntry>();
  const originalIndexById = new Map<string, number>();
  for (let index = 0; index < allEntries.length; index += 1) {
    const entry = allEntries[index];
    entryById.set(entry.id, entry);
    originalIndexById.set(entry.id, index);
  }
  const activeBranchIds = new Set<string>();
  for (const entry of branch) {
    activeBranchIds.add(entry.id);
  }
  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    let parentId = entry.parentId;
    while (parentId !== null && removedIds.has(parentId)) {
      parentId = entryById.get(parentId)?.parentId ?? null;
    }

    keptEntries.push(
      parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry),
    );
  }

  return orderSuccessorEntries({
    entries: keptEntries,
    activeBranchIds,
    originalIndexById,
  });
}

function collectLatestStateEntryIds(entries: SessionEntry[]): Set<string> {
  const latestByType = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (isDedupedStateEntry(entry)) {
      latestByType.set(entry.type, entry);
    }
  }
  const ids = new Set<string>();
  for (const entry of latestByType.values()) {
    ids.add(entry.id);
  }
  return ids;
}

function isDedupedStateEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    entry.type === "session_info"
  );
}

function orderSuccessorEntries(params: {
  entries: SessionEntry[];
  activeBranchIds: Set<string>;
  originalIndexById: Map<string, number>;
}): SessionEntry[] {
  const { entries, activeBranchIds, originalIndexById } = params;
  const entryIds = new Set<string>();
  for (const entry of entries) {
    entryIds.add(entry.id);
  }
  const childrenByParentId = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const parentId =
      entry.parentId !== null && entryIds.has(entry.parentId) ? entry.parentId : null;
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry));
    childrenByParentId.set(parentId, children);
  }

  const sortForActiveLeaf = (left: SessionEntry, right: SessionEntry) => {
    const leftActive = activeBranchIds.has(left.id);
    const rightActive = activeBranchIds.has(right.id);
    if (leftActive !== rightActive) {
      return leftActive ? 1 : -1;
    }
    return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);
  };

  const ordered: SessionEntry[] = [];
  const emittedIds = new Set<string>();
  const emitSubtree = (entry: SessionEntry) => {
    if (emittedIds.has(entry.id)) {
      return;
    }
    emittedIds.add(entry.id);
    ordered.push(entry);
    for (const child of (childrenByParentId.get(entry.id) ?? []).toSorted(sortForActiveLeaf)) {
      emitSubtree(child);
    }
  };

  for (const root of (childrenByParentId.get(null) ?? []).toSorted(sortForActiveLeaf)) {
    emitSubtree(root);
  }

  // Defensive fallback for malformed transcripts with cycles or broken parents.
  for (const entry of entries.toSorted(sortForActiveLeaf)) {
    emitSubtree(entry);
  }

  return ordered;
}

function buildSuccessorHeader(params: {
  previousHeader: SessionHeader | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  parentSession: string;
}): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: params.timestamp,
    cwd: params.previousHeader?.cwd || params.cwd,
    parentSession: params.parentSession,
  };
}

function resolveSuccessorTranscriptPath(params: {
  transcriptPath: string;
  sessionId: string;
  agentId: string;
}): string {
  const existing = resolveSqliteSessionTranscriptScopeForPath({
    transcriptPath: params.transcriptPath,
  });
  return createSqliteSessionTranscriptLocator({
    agentId: params.agentId || existing?.agentId || DEFAULT_AGENT_ID,
    sessionId: params.sessionId,
  });
}
