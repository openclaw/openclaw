import fs from "node:fs/promises";
import path from "node:path";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { log } from "./logger.js";

/**
 * Truncate a session JSONL file after compaction by removing entries
 * that are no longer reachable from the current branch.
 *
 * After compaction, the session file still contains all historical entries
 * even though `buildSessionContext()` logically skips entries before
 * `firstKeptEntryId`. Over many compaction cycles this causes unbounded
 * file growth (issue #39953).
 *
 * This function rewrites the file to keep only:
 * 1. The session header
 * 2. The latest compaction entry (re-parented as root)
 * 3. All entries after the compaction in the current branch
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

  const entriesRemoved = latestCompactionIdx;
  const totalEntriesBefore = sm.getEntries().length;

  // Build the truncated entry list:
  // compaction entry (re-parented as root) + all entries after it
  const truncatedEntries: SessionEntry[] = [];

  const compactionEntry = branch[latestCompactionIdx] as CompactionEntry;
  truncatedEntries.push({ ...compactionEntry, parentId: null });

  for (let i = latestCompactionIdx + 1; i < branch.length; i++) {
    truncatedEntries.push(branch[i]);
  }

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
  const lines: string[] = [
    JSON.stringify(header),
    ...truncatedEntries.map((e) => JSON.stringify(e)),
  ];
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
      `entriesBefore=${totalEntriesBefore} entriesAfter=${truncatedEntries.length} ` +
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
