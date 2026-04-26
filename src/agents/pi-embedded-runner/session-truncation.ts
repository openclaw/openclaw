import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { finished } from "node:stream/promises";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";

const MAX_SESSION_TRUNCATION_LINE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_TRUNCATION_ENTRIES = 250_000;

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
  const sessionLock = await acquireSessionWriteLock({
    sessionFile: params.sessionFile,
    allowReentrant: true,
  });
  try {
    return await truncateSessionAfterCompactionLocked(params);
  } finally {
    await sessionLock.release();
  }
}

async function truncateSessionAfterCompactionLocked(params: {
  sessionFile: string;
  /** Optional path to archive the pre-truncation file. */
  archivePath?: string;
}): Promise<TruncationResult> {
  const { sessionFile } = params;

  const scan = await scanSessionFile(sessionFile);
  if (!scan.ok) {
    log.warn(`[session-truncation] Failed to scan session file: ${scan.reason}`);
    return { truncated: false, entriesRemoved: 0, reason: scan.reason };
  }

  const { headerLine, entries, entryById } = scan;
  if (!headerLine) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const branch = buildCurrentBranch(entries, entryById);
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
  const compactionEntry = branch[latestCompactionIdx];
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

  // Only remove message-type entries that the compaction actually summarized.
  // Non-message session state (custom, model_change, thinking_level_change,
  // session_info, custom_message) is preserved even if it sits in the
  // summarized portion of the branch.
  //
  // label and branch_summary entries that reference removed message IDs are
  // also dropped to avoid dangling metadata (consistent with the approach in
  // tool-result-truncation.ts).
  const removedIds = new Set<string>();
  for (const entry of entries) {
    if (summarizedBranchIds.has(entry.id) && entry.type === "message") {
      removedIds.add(entry.id);
    }
  }

  // Labels bookmark targetId while parentId just records the leaf when the
  // label was changed, so targetId determines whether the label is still valid.
  // Branch summaries still hang off the summarized branch via parentId.
  for (const entry of entries) {
    if (
      entry.type === "label" &&
      typeof entry.targetId === "string" &&
      removedIds.has(entry.targetId)
    ) {
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

  const entriesRemoved = removedIds.size;
  const totalEntriesBefore = entries.length;

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
      const reason = formatErrorMessage(err);
      log.warn(`[session-truncation] Failed to archive: ${reason}`);
    }
  }

  const tmpFile = createTruncationTmpFile(sessionFile);
  try {
    const rewrite = await rewriteSessionFile({
      sessionFile,
      tmpFile,
      headerLine,
      removedIds,
      entryById,
    });
    await fs.rename(tmpFile, sessionFile);
    const bytesAfter = rewrite.bytesAfter;

    log.info(
      `[session-truncation] Truncated session file: ` +
        `entriesBefore=${totalEntriesBefore} entriesAfter=${rewrite.entriesAfter} ` +
        `removed=${entriesRemoved} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
        `reduction=${bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(1) : "?"}%`,
    );

    return { truncated: true, entriesRemoved, bytesBefore, bytesAfter };
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    const reason = formatErrorMessage(err);
    log.warn(`[session-truncation] Failed to write truncated file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }
}

type SessionEntryMeta = {
  id: string;
  parentId: string | null;
  type: string;
  firstKeptEntryId?: string;
  targetId?: string;
};

type SessionFileScanResult =
  | {
      ok: true;
      headerLine: string | null;
      entries: SessionEntryMeta[];
      entryById: Map<string, SessionEntryMeta>;
    }
  | { ok: false; reason: string };

function normalizeEntryMeta(value: unknown): SessionEntryMeta | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "session") {
    return null;
  }
  if (typeof record.id !== "string" || !record.id) {
    return null;
  }
  const parentId = typeof record.parentId === "string" ? record.parentId : null;
  return {
    id: record.id,
    parentId,
    type: typeof record.type === "string" ? record.type : "",
    ...(typeof record.firstKeptEntryId === "string"
      ? { firstKeptEntryId: record.firstKeptEntryId }
      : {}),
    ...(typeof record.targetId === "string" ? { targetId: record.targetId } : {}),
  };
}

async function forEachJsonlLine(
  filePath: string,
  callback: (line: string, lineNumber: number) => Promise<void> | void,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) {
        continue;
      }
      const lineBytes = Buffer.byteLength(line, "utf-8");
      if (lineBytes > MAX_SESSION_TRUNCATION_LINE_BYTES) {
        throw new Error(
          `Session JSONL line ${lineNumber} exceeds ${MAX_SESSION_TRUNCATION_LINE_BYTES} bytes`,
        );
      }
      await callback(line, lineNumber);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function scanSessionFile(sessionFile: string): Promise<SessionFileScanResult> {
  const entries: SessionEntryMeta[] = [];
  const entryById = new Map<string, SessionEntryMeta>();
  let headerLine: string | null = null;

  try {
    await forEachJsonlLine(sessionFile, (line, lineNumber) => {
      const parsed = parseJsonlLine(line, lineNumber);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { type?: unknown }).type === "session"
      ) {
        headerLine ??= line;
        return;
      }
      const meta = normalizeEntryMeta(parsed);
      if (!meta) {
        return;
      }
      if (entries.length >= MAX_SESSION_TRUNCATION_ENTRIES) {
        throw new Error(
          `Session transcript exceeds ${MAX_SESSION_TRUNCATION_ENTRIES} entries during truncation scan`,
        );
      }
      entries.push(meta);
      entryById.set(meta.id, meta);
    });
  } catch (err) {
    return { ok: false, reason: formatErrorMessage(err) };
  }

  return { ok: true, headerLine, entries, entryById };
}

function buildCurrentBranch(
  entries: SessionEntryMeta[],
  entryById: Map<string, SessionEntryMeta>,
): SessionEntryMeta[] {
  const branch: SessionEntryMeta[] = [];
  const seen = new Set<string>();
  let cursor = entries.at(-1);
  while (cursor && !seen.has(cursor.id)) {
    branch.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId ? entryById.get(cursor.parentId) : undefined;
  }
  return branch.toReversed();
}

function resolveKeptParentId(params: {
  parentId: string | null;
  removedIds: Set<string>;
  entryById: Map<string, SessionEntryMeta>;
}): string | null {
  let parentId = params.parentId;
  const seen = new Set<string>();
  while (parentId !== null && params.removedIds.has(parentId)) {
    if (seen.has(parentId)) {
      return null;
    }
    seen.add(parentId);
    const parent = params.entryById.get(parentId);
    parentId = parent?.parentId ?? null;
  }
  return parentId;
}

async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`, "utf-8")) {
    await waitForDrain(stream);
  }
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function createTruncationTmpFile(sessionFile: string): string {
  return path.join(
    path.dirname(sessionFile),
    `.${path.basename(sessionFile)}.${randomUUID()}.truncate-tmp`,
  );
}

function parseJsonlLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(
      `Malformed JSONL in session transcript at line ${lineNumber}: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

async function rewriteSessionFile(params: {
  sessionFile: string;
  tmpFile: string;
  headerLine: string;
  removedIds: Set<string>;
  entryById: Map<string, SessionEntryMeta>;
}): Promise<{ entriesAfter: number; bytesAfter: number }> {
  const output = createWriteStream(params.tmpFile, {
    encoding: "utf-8",
    flags: "wx",
    mode: 0o600,
  });
  const outputFinished = finished(output);
  let entriesAfter = 0;
  let bytesAfter = 0;

  try {
    await writeLine(output, params.headerLine);
    bytesAfter += Buffer.byteLength(`${params.headerLine}\n`, "utf-8");

    await forEachJsonlLine(params.sessionFile, async (line, lineNumber) => {
      const parsed = parseJsonlLine(line, lineNumber);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { type?: unknown }).type === "session"
      ) {
        return;
      }
      const meta = normalizeEntryMeta(parsed);
      if (!meta || params.removedIds.has(meta.id)) {
        return;
      }

      const newParentId = resolveKeptParentId({
        parentId: meta.parentId,
        removedIds: params.removedIds,
        entryById: params.entryById,
      });
      const outputLine =
        newParentId === meta.parentId
          ? line
          : JSON.stringify({ ...(parsed as SessionEntry), parentId: newParentId });

      await writeLine(output, outputLine);
      entriesAfter++;
      bytesAfter += Buffer.byteLength(`${outputLine}\n`, "utf-8");
    });
  } finally {
    output.end();
    await outputFinished;
  }

  return { entriesAfter, bytesAfter };
}

export type TruncationResult = {
  truncated: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};
