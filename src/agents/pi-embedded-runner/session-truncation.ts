import fs from "node:fs/promises";
import path from "node:path";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { log } from "./logger.js";

type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;

export const DEFAULT_ROLLING_TRANSCRIPT_KEEP_RECENT_MESSAGES = 40;

function findLatestCompactionIndex(branch: SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      return i;
    }
  }
  return -1;
}

function collectCompactionProtectedMessageIds(branch: SessionEntry[]): Set<string> {
  const latestCompactionIdx = findLatestCompactionIndex(branch);
  if (latestCompactionIdx < 0) {
    return new Set();
  }

  const compactionEntry = branch[latestCompactionIdx] as CompactionEntry;
  const firstKeptEntryId = compactionEntry.firstKeptEntryId?.trim();
  if (!firstKeptEntryId) {
    return new Set();
  }

  const protectedIds = new Set<string>();
  let inProtectedTail = false;
  for (let i = 0; i < latestCompactionIdx; i++) {
    const entry = branch[i];
    if (entry.id === firstKeptEntryId) {
      inProtectedTail = true;
    }
    if (inProtectedTail && entry.type === "message") {
      protectedIds.add(entry.id);
    }
  }
  return protectedIds;
}

function collectRollingWindowMessageIds(
  branch: SessionEntry[],
  keepRecentMessages: number,
): Set<string> {
  const messageEntries = branch.filter(
    (entry): entry is SessionMessageEntry => entry.type === "message",
  );
  if (messageEntries.length <= keepRecentMessages) {
    return new Set(messageEntries.map((entry) => entry.id));
  }

  let startIndex = Math.max(0, messageEntries.length - keepRecentMessages);

  // Never start the retained suffix on a tool result; keep the matching
  // assistant turn so replayed transcripts still satisfy strict providers.
  while (startIndex > 0 && messageEntries[startIndex]?.message.role === "toolResult") {
    startIndex -= 1;
  }

  return new Set(messageEntries.slice(startIndex).map((entry) => entry.id));
}

function expandRemovedIdsForDanglingMetadata(
  allEntries: SessionEntry[],
  removedIds: Set<string>,
): Set<string> {
  const expanded = new Set(removedIds);

  for (const entry of allEntries) {
    if (entry.type === "label" && expanded.has(entry.targetId)) {
      expanded.add(entry.id);
      continue;
    }
    if (
      entry.type === "branch_summary" &&
      entry.parentId !== null &&
      expanded.has(entry.parentId)
    ) {
      expanded.add(entry.id);
    }
  }

  return expanded;
}

function rebuildEntriesAfterRemoval(
  allEntries: SessionEntry[],
  removedIds: Set<string>,
): SessionEntry[] {
  const entryById = new Map<string, SessionEntry>();
  for (const entry of allEntries) {
    entryById.set(entry.id, entry);
  }

  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    let newParentId = entry.parentId;
    while (newParentId !== null && removedIds.has(newParentId)) {
      const parent = entryById.get(newParentId);
      newParentId = parent?.parentId ?? null;
    }

    if (newParentId !== entry.parentId) {
      keptEntries.push({ ...entry, parentId: newParentId });
    } else {
      keptEntries.push(entry);
    }
  }

  return keptEntries;
}

async function writeSessionEntriesAtomically(params: {
  sessionFile: string;
  header: ReturnType<SessionManager["getHeader"]>;
  keptEntries: SessionEntry[];
}): Promise<{ content: string } | { reason: string }> {
  const { sessionFile, header, keptEntries } = params;
  if (!header) {
    return { reason: "missing session header" };
  }

  const lines: string[] = [
    JSON.stringify(header),
    ...keptEntries.map((entry) => JSON.stringify(entry)),
  ];
  const content = lines.join("\n") + "\n";
  const tmpFile = `${sessionFile}.truncate-tmp`;

  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    await fs.rename(tmpFile, sessionFile);
    return { content };
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
    return {
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Truncate a session JSONL file after compaction by removing only the
 * message entries that the compaction actually summarized.
 *
 * After compaction, the session file still contains all historical entries
 * even though `buildSessionContext()` logically skips entries before
 * `firstKeptEntryId`. Over many compaction cycles this causes unbounded
 * file growth (issue #39953).
 *
 * This function rewrites the file keeping:
 * 1. The session header
 * 2. All non-message session state (custom, model_change, thinking_level_change,
 *    session_info, custom_message, compaction entries)
 *    Note: label and branch_summary entries referencing removed messages are
 *    also dropped to avoid dangling metadata.
 * 3. All entries from sibling branches not covered by the compaction
 * 4. The unsummarized tail: entries from `firstKeptEntryId` through (and
 *    including) the compaction entry, plus all entries after it
 *
 * Only `message` entries in the current branch that precede the compaction's
 * `firstKeptEntryId` are removed — they are the entries the compaction
 * actually summarized. Entries from `firstKeptEntryId` onward are preserved
 * because `buildSessionContext()` expects them when reconstructing the
 * session. Entries whose parent was removed are re-parented to the nearest
 * kept ancestor (or become roots).
 */
export async function truncateSessionAfterCompaction(params: {
  sessionFile: string;
  /** Optional path to archive the pre-truncation file. */
  archivePath?: string;
}): Promise<TruncationResult> {
  const { sessionFile } = params;

  let sm: SessionManager;
  try {
    sm = SessionManager.open(sessionFile);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[session-truncation] Failed to open session file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const header = sm.getHeader();
  if (!header) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const branch = sm.getBranch();
  if (branch.length === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "empty session" };
  }

  // Find the latest compaction entry in the current branch
  const latestCompactionIdx = findLatestCompactionIndex(branch);

  if (latestCompactionIdx < 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no compaction entry found" };
  }

  // Nothing to truncate if compaction is already at root
  if (latestCompactionIdx === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "compaction already at root" };
  }

  // The compaction's firstKeptEntryId marks the start of the "unsummarized
  // tail" — entries from firstKeptEntryId through the compaction that
  // buildSessionContext() expects to find when reconstructing the session.
  // Only entries *before* firstKeptEntryId were actually summarized.
  const compactionEntry = branch[latestCompactionIdx] as CompactionEntry;
  const { firstKeptEntryId } = compactionEntry;

  // Collect IDs of entries in the current branch that were actually summarized
  // (everything before firstKeptEntryId). Entries from firstKeptEntryId through
  // the compaction are the unsummarized tail and must be preserved.
  const summarizedBranchIds = new Set<string>();
  for (let i = 0; i < latestCompactionIdx; i++) {
    if (firstKeptEntryId && branch[i].id === firstKeptEntryId) {
      break; // Everything from here to the compaction is the unsummarized tail
    }
    summarizedBranchIds.add(branch[i].id);
  }

  // Operate on the full transcript so sibling branches and tree metadata
  // are not silently dropped.
  const allEntries = sm.getEntries();

  // Only remove message-type entries that the compaction actually summarized.
  // Non-message session state (custom, model_change, thinking_level_change,
  // session_info, custom_message) is preserved even if it sits in the
  // summarized portion of the branch.
  //
  // label and branch_summary entries that reference removed message IDs are
  // also dropped to avoid dangling metadata (consistent with the approach in
  // tool-result-truncation.ts).
  const removedIds = new Set<string>();
  for (const entry of allEntries) {
    if (summarizedBranchIds.has(entry.id) && entry.type === "message") {
      removedIds.add(entry.id);
    }
  }
  const expandedRemovedIds = expandRemovedIdsForDanglingMetadata(allEntries, removedIds);

  if (expandedRemovedIds.size === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no entries to remove" };
  }

  const keptEntries = rebuildEntriesAfterRemoval(allEntries, expandedRemovedIds);

  const entriesRemoved = expandedRemovedIds.size;
  const totalEntriesBefore = allEntries.length;

  // Get file size before truncation
  let bytesBefore = 0;
  try {
    const stat = await fs.stat(sessionFile);
    bytesBefore = stat.size;
  } catch {
    // If stat fails, continue anyway
  }

  // Archive original file if requested
  if (params.archivePath) {
    try {
      const archiveDir = path.dirname(params.archivePath);
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.copyFile(sessionFile, params.archivePath);
      log.info(`[session-truncation] Archived pre-truncation file to ${params.archivePath}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[session-truncation] Failed to archive: ${reason}`);
    }
  }

  const writeResult = await writeSessionEntriesAtomically({
    sessionFile,
    header,
    keptEntries,
  });
  if ("reason" in writeResult) {
    const reason = writeResult.reason;
    log.warn(`[session-truncation] Failed to write truncated file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const bytesAfter = Buffer.byteLength(writeResult.content, "utf-8");

  log.info(
    `[session-truncation] Truncated session file: ` +
      `entriesBefore=${totalEntriesBefore} entriesAfter=${keptEntries.length} ` +
      `removed=${entriesRemoved} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `reduction=${bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(1) : "?"}%`,
  );

  return { truncated: true, entriesRemoved, bytesBefore, bytesAfter };
}

/**
 * Prune persisted transcript messages on the active branch once the on-disk
 * session file exceeds a configured size. Unlike post-compaction truncation,
 * this also applies to ordinary long-running sessions that have never compacted.
 *
 * Only `message` entries are removed. Non-message session state remains
 * intact, and the latest compaction tail (firstKeptEntryId → compaction) is
 * always preserved so future `buildSessionContext()` calls stay valid.
 */
export async function pruneSessionTranscriptRollingWindow(params: {
  sessionFile: string;
  maxBytes: number;
  keepRecentMessages?: number;
  sessionManager?: SessionManager;
}): Promise<RollingTranscriptPruneResult> {
  const maxBytes = Number.isFinite(params.maxBytes) ? Math.floor(params.maxBytes) : 0;
  if (maxBytes <= 0) {
    return { pruned: false, entriesRemoved: 0, reason: "disabled" };
  }

  let bytesBefore = 0;
  try {
    const stat = await fs.stat(params.sessionFile);
    bytesBefore = stat.size;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { pruned: false, entriesRemoved: 0, reason };
  }

  if (bytesBefore <= maxBytes) {
    return { pruned: false, entriesRemoved: 0, bytesBefore, reason: "below threshold" };
  }

  let sessionManager = params.sessionManager;
  if (!sessionManager) {
    try {
      sessionManager = SessionManager.open(params.sessionFile);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[transcript-pruning] Failed to open session file: ${reason}`);
      return { pruned: false, entriesRemoved: 0, bytesBefore, reason };
    }
  }

  const header = sessionManager.getHeader();
  if (!header) {
    return { pruned: false, entriesRemoved: 0, bytesBefore, reason: "missing session header" };
  }

  const branch = sessionManager.getBranch();
  if (branch.length === 0) {
    return { pruned: false, entriesRemoved: 0, bytesBefore, reason: "empty session" };
  }

  const keepRecentMessages = Math.max(
    1,
    Math.floor(params.keepRecentMessages ?? DEFAULT_ROLLING_TRANSCRIPT_KEEP_RECENT_MESSAGES),
  );
  const recentWindowIds = collectRollingWindowMessageIds(branch, keepRecentMessages);
  const protectedIds = collectCompactionProtectedMessageIds(branch);
  const allEntries = sessionManager.getEntries();
  const removedIds = new Set<string>();

  for (const entry of branch) {
    if (entry.type === "message" && !recentWindowIds.has(entry.id) && !protectedIds.has(entry.id)) {
      removedIds.add(entry.id);
    }
  }

  const expandedRemovedIds = expandRemovedIdsForDanglingMetadata(allEntries, removedIds);
  if (expandedRemovedIds.size === 0) {
    return {
      pruned: false,
      entriesRemoved: 0,
      bytesBefore,
      reason: "no messages outside protected window",
    };
  }

  const keptEntries = rebuildEntriesAfterRemoval(allEntries, expandedRemovedIds);
  const writeResult = await writeSessionEntriesAtomically({
    sessionFile: params.sessionFile,
    header,
    keptEntries,
  });
  if ("reason" in writeResult) {
    const reason = writeResult.reason;
    log.warn(`[transcript-pruning] Failed to write pruned session file: ${reason}`);
    return { pruned: false, entriesRemoved: 0, bytesBefore, reason };
  }

  const bytesAfter = Buffer.byteLength(writeResult.content, "utf-8");
  log.info(
    `[transcript-pruning] Pruned rolling window: ` +
      `entriesBefore=${allEntries.length} entriesAfter=${keptEntries.length} ` +
      `removed=${expandedRemovedIds.size} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `keepRecentMessages=${keepRecentMessages}`,
  );

  return {
    pruned: true,
    entriesRemoved: expandedRemovedIds.size,
    bytesBefore,
    bytesAfter,
  };
}

export type TruncationResult = {
  truncated: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};

export type RollingTranscriptPruneResult = {
  pruned: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};
