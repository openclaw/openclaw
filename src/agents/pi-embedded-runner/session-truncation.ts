import fs from "node:fs/promises";
import path from "node:path";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { log } from "./logger.js";

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
  let latestCompactionIdx = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      latestCompactionIdx = i;
      break;
    }
  }

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

  // Labels bookmark targetId while parentId just records the leaf when the
  // label was changed, so targetId determines whether the label is still valid.
  // Branch summaries still hang off the summarized branch via parentId.
  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
      continue;
    }
    if (
      entry.type === "branch_summary" &&
      entry.parentId !== null &&
      removedIds.has(entry.parentId)
    ) {
      removedIds.add(entry.id);
    }
  }

  if (removedIds.size === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no entries to remove" };
  }

  // Build an id→entry map for walking parent chains during re-parenting.
  const entryById = new Map<string, SessionEntry>();
  for (const entry of allEntries) {
    entryById.set(entry.id, entry);
  }

  // Keep every entry that was not removed, re-parenting where necessary so
  // the tree stays connected.
  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    // Walk up the parent chain to find the nearest kept ancestor.
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

  const entriesRemoved = removedIds.size;
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

  // Write truncated file atomically (temp + rename)
  const lines: string[] = [JSON.stringify(header), ...keptEntries.map((e) => JSON.stringify(e))];
  const content = lines.join("\n") + "\n";

  const tmpFile = `${sessionFile}.truncate-tmp`;
  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    await fs.rename(tmpFile, sessionFile);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[session-truncation] Failed to write truncated file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const bytesAfter = Buffer.byteLength(content, "utf-8");

  log.info(
    `[session-truncation] Truncated session file: ` +
      `entriesBefore=${totalEntriesBefore} entriesAfter=${keptEntries.length} ` +
      `removed=${entriesRemoved} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `reduction=${bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(1) : "?"}%`,
  );

  return { truncated: true, entriesRemoved, bytesBefore, bytesAfter };
}

export type TruncationResult = {
  truncated: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};
