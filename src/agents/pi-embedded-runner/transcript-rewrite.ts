import fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRawSessionAppendMessage } from "../session-raw-append-message.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionBranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];

function estimateMessageBytes(message: AgentMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function remapEntryId(
  entryId: string | null | undefined,
  rewrittenEntryIds: ReadonlyMap<string, string>,
): string | null {
  if (!entryId) {
    return null;
  }
  return rewrittenEntryIds.get(entryId) ?? entryId;
}

function appendBranchEntry(params: {
  sessionManager: SessionManagerLike;
  entry: SessionBranchEntry;
  rewrittenEntryIds: ReadonlyMap<string, string>;
  appendMessage: SessionManagerLike["appendMessage"];
}): string {
  const { sessionManager, entry, rewrittenEntryIds, appendMessage } = params;
  if (entry.type === "message") {
    return appendMessage(entry.message as Parameters<typeof sessionManager.appendMessage>[0]);
  }
  if (entry.type === "compaction") {
    return sessionManager.appendCompaction(
      entry.summary,
      remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
    );
  }
  if (entry.type === "thinking_level_change") {
    return sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
  }
  if (entry.type === "model_change") {
    return sessionManager.appendModelChange(entry.provider, entry.modelId);
  }
  if (entry.type === "custom") {
    return sessionManager.appendCustomEntry(entry.customType, entry.data);
  }
  if (entry.type === "custom_message") {
    return sessionManager.appendCustomMessageEntry(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
    );
  }
  if (entry.type === "session_info") {
    if (entry.name) {
      return sessionManager.appendSessionInfo(entry.name);
    }
    return sessionManager.appendSessionInfo("");
  }
  if (entry.type === "branch_summary") {
    return sessionManager.branchWithSummary(
      remapEntryId(entry.parentId, rewrittenEntryIds),
      entry.summary,
      entry.details,
      entry.fromHook,
    );
  }
  return sessionManager.appendLabelChange(
    remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId,
    entry.label,
  );
}

/**
 * Safely rewrites transcript message entries on the active branch by branching
 * from the first rewritten message's parent and re-appending the suffix.
 */
export function rewriteTranscriptEntriesInSessionManager(params: {
  sessionManager: SessionManagerLike;
  replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult {
  const replacementsById = new Map(
    params.replacements
      .filter((replacement) => replacement.entryId.trim().length > 0)
      .map((replacement) => [replacement.entryId, replacement.message]),
  );
  if (replacementsById.size === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no replacements requested",
    };
  }

  const branch = params.sessionManager.getBranch();
  if (branch.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "empty session",
    };
  }

  const matchedIndices: number[] = [];
  let bytesFreed = 0;

  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "message") {
      continue;
    }
    const replacement = replacementsById.get(entry.id);
    if (!replacement) {
      continue;
    }
    const originalBytes = estimateMessageBytes(entry.message);
    const replacementBytes = estimateMessageBytes(replacement);
    matchedIndices.push(index);
    bytesFreed += Math.max(0, originalBytes - replacementBytes);
  }

  if (matchedIndices.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "no matching message entries",
    };
  }

  const firstMatchedEntry = branch[matchedIndices[0]] as
    | Extract<SessionBranchEntry, { type: "message" }>
    | undefined;
  // matchedIndices only contains indices of branch "message" entries.
  if (!firstMatchedEntry) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "invalid first rewrite target",
    };
  }

  if (!firstMatchedEntry.parentId) {
    params.sessionManager.resetLeaf();
  } else {
    params.sessionManager.branch(firstMatchedEntry.parentId);
  }

  // Maintenance rewrites should preserve the exact requested history without
  // re-running persistence hooks or size truncation on replayed messages.
  const appendMessage = getRawSessionAppendMessage(params.sessionManager);
  const rewrittenEntryIds = new Map<string, string>();
  for (let index = matchedIndices[0]; index < branch.length; index++) {
    const entry = branch[index];
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    const newEntryId =
      replacement === undefined
        ? appendBranchEntry({
            sessionManager: params.sessionManager,
            entry,
            rewrittenEntryIds,
            appendMessage,
          })
        : appendMessage(replacement as Parameters<typeof params.sessionManager.appendMessage>[0]);
    rewrittenEntryIds.set(entry.id, newEntryId);
  }

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
  };
}

type RewriteArtifactCleanupResult = {
  removedEntries: number;
  bytesRemoved: number;
};

/**
 * Collect the ids of the entries on the currently active branch path. This
 * is the set of "potentially abandonable" entries — anything not on this path
 * (legitimate sibling branches from prior `sm.branch()` navigation, etc.) is
 * never considered for removal.
 */
function collectActiveBranchEntryIds(sessionManager: SessionManagerLike): Set<string> {
  const ids = new Set<string>();
  for (const entry of sessionManager.getBranch()) {
    if (entry && typeof (entry as { id?: unknown }).id === "string") {
      ids.add((entry as { id: string }).id);
    }
  }
  return ids;
}

/**
 * Remove ONLY those entry ids that we can prove were just abandoned by this
 * rewrite (present in the pre-rewrite active branch, absent from the
 * post-rewrite active branch) AND that no surviving entry still references
 * as an ancestor via `parentId`.
 *
 * Single pass: read the file once, parse each line once, compute the
 * ancestry-live set from non-abandoned entries, and write the kept lines
 * back atomically. Session files can reach multiple megabytes near the
 * compaction boundary (which is exactly when this cleanup runs), so we
 * avoid doing the read + parse twice.
 *
 * Legitimate sibling branches — alternate paths the user navigated to via
 * `sm.branch(...)` — never appear in `getBranch()` directly, so their ids
 * are never part of the abandoned set. But a sibling can hang off an entry
 * that IS in the abandoned set (the rewrite replaced what used to be a
 * branch point). The ancestry-reference filter catches that case and keeps
 * the shared-ancestor entry in the file so the sibling stays grounded.
 *
 * Matches the repo-wide invariant documented in session-truncation: rewrite /
 * maintenance operations must preserve unsummarized sibling branches.
 */
function removeSpecificAbandonedEntriesFromSessionFile(
  sessionFile: string,
  abandonedEntryIds: ReadonlySet<string>,
): RewriteArtifactCleanupResult {
  if (abandonedEntryIds.size === 0) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  // Single parse pass: we need each line's raw form (for write-back), its id
  // (for candidate lookup) and its parentId (for ancestry traversal).
  type ParsedLine = {
    raw: string;
    id?: string;
    parentId?: string | null;
  };
  const parsed: ParsedLine[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) {
      continue;
    }
    try {
      const obj = JSON.parse(raw) as { id?: unknown; parentId?: unknown };
      parsed.push({
        raw,
        id: typeof obj.id === "string" ? obj.id : undefined,
        parentId:
          typeof obj.parentId === "string"
            ? obj.parentId
            : obj.parentId === null
              ? null
              : undefined,
      });
    } catch {
      // Malformed line: kept verbatim by the write step, ignored for ancestry.
      parsed.push({ raw });
    }
  }
  const byId = new Map<string, ParsedLine>();
  for (const line of parsed) {
    if (line.id) {
      byId.set(line.id, line);
    }
  }
  // Walk parentId chains backward from every non-abandoned entry. Ids visited
  // on any such walk are load-bearing ancestors of surviving entries and must
  // not be removed even if they are in the candidate set.
  const ancestryLive = new Set<string>();
  for (const line of parsed) {
    if (!line.id) {
      continue;
    }
    if (abandonedEntryIds.has(line.id)) {
      continue;
    }
    let cursor: ParsedLine | undefined = line;
    while (cursor && cursor.id) {
      if (ancestryLive.has(cursor.id)) {
        break;
      }
      ancestryLive.add(cursor.id);
      const parentId = cursor.parentId;
      if (typeof parentId !== "string" || !parentId) {
        break;
      }
      cursor = byId.get(parentId);
    }
  }
  // Final removable set = candidates \ ancestry-of-non-abandoned.
  const safeAbandonedIds = new Set<string>();
  for (const id of abandonedEntryIds) {
    if (!ancestryLive.has(id)) {
      safeAbandonedIds.add(id);
    }
  }
  if (safeAbandonedIds.size === 0) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const kept: string[] = [];
  let removed = 0;
  for (const line of parsed) {
    if (line.id && safeAbandonedIds.has(line.id)) {
      removed += 1;
      continue;
    }
    kept.push(line.raw);
  }
  if (removed === 0) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const newContent = `${kept.join("\n")}\n`;
  const originalSize = Buffer.byteLength(content, "utf-8");
  const newSize = Buffer.byteLength(newContent, "utf-8");
  const tmp = `${sessionFile}.rewrite-cleanup.tmp`;
  try {
    fs.writeFileSync(tmp, newContent, "utf-8");
    fs.renameSync(tmp, sessionFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    log.warn(
      `[transcript-rewrite] abandoned-entry cleanup write failed: ${formatErrorMessage(err)}`,
    );
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  return { removedEntries: removed, bytesRemoved: originalSize - newSize };
}

/**
 * Open a transcript file, rewrite message entries on the active branch, and
 * emit a transcript update when the active branch changed.
 */
export async function rewriteTranscriptEntriesInSessionFile(params: {
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
  request: TranscriptRewriteRequest;
}): Promise<TranscriptRewriteResult> {
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });
    const sessionManager = SessionManager.open(params.sessionFile);
    // Snapshot of the active-branch ids BEFORE the rewrite. Sibling branches
    // that already exist as alternate paths are not on this branch and are
    // therefore excluded from the abandoned set by construction.
    const branchIdsBefore = collectActiveBranchEntryIds(sessionManager);
    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: params.request.replacements,
    });
    if (result.changed) {
      // Entries that were on the active branch before the rewrite but are no
      // longer part of the post-rewrite active branch have been abandoned by
      // this specific rewrite and are safe to drop from the file.
      const branchIdsAfter = collectActiveBranchEntryIds(sessionManager);
      const abandonedIds = new Set<string>();
      for (const id of branchIdsBefore) {
        if (!branchIdsAfter.has(id)) {
          abandonedIds.add(id);
        }
      }
      const cleanupResult = removeSpecificAbandonedEntriesFromSessionFile(
        params.sessionFile,
        abandonedIds,
      );
      emitSessionTranscriptUpdate(params.sessionFile);
      log.info(
        `[transcript-rewrite] rewrote ${result.rewrittenEntries} entr` +
          `${result.rewrittenEntries === 1 ? "y" : "ies"} ` +
          `bytesFreed=${result.bytesFreed} ` +
          `abandonedArtifactsRemoved=${cleanupResult.removedEntries}/` +
          `bytes:${cleanupResult.bytesRemoved} ` +
          `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
      );
    }
    return result;
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`[transcript-rewrite] failed: ${reason}`);
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason,
    };
  } finally {
    await sessionLock?.release();
  }
}
