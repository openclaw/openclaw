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

type ActiveLeafBranchCompactionResult = {
  removedEntries: number;
  bytesRemoved: number;
};

/**
 * After a rewrite, the session file still carries all pre-rewrite entries as
 * abandoned sibling branches of the new leaf (append-only semantics). Because
 * openclaw's transcript reader scans every line in the file, those abandoned
 * entries show up as duplicates in the replay — each successive rewrite piles
 * on another generation. This helper keeps only entries that are reachable
 * from the current leaf via the parentId chain, plus parentId-less roots
 * (session header / model_change), and atomically rewrites the file.
 *
 * Identity is based on the structural parentId chain, not textual content.
 */
function compactSessionFileToActiveLeafBranch(
  sessionFile: string,
  leafId: string | null | undefined,
): ActiveLeafBranchCompactionResult {
  if (!leafId) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const rawLines = content.split("\n");
  type ParsedLine = {
    raw: string;
    id?: string;
    parentId?: string | null;
    type?: string;
  };
  const parsed: ParsedLine[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) {
      continue;
    }
    try {
      const obj = JSON.parse(raw) as {
        id?: unknown;
        parentId?: unknown;
        type?: unknown;
      };
      parsed.push({
        raw,
        id: typeof obj.id === "string" ? obj.id : undefined,
        parentId:
          typeof obj.parentId === "string"
            ? obj.parentId
            : obj.parentId === null
              ? null
              : undefined,
        type: typeof obj.type === "string" ? obj.type : undefined,
      });
    } catch {
      // Malformed line: keep it verbatim so we don't lose data.
      parsed.push({ raw });
    }
  }
  if (parsed.length === 0) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const byId = new Map<string, ParsedLine>();
  for (const line of parsed) {
    if (line.id) {
      byId.set(line.id, line);
    }
  }
  // Walk backward from the current leaf to the root; collect all reachable ids.
  const keepIds = new Set<string>();
  let cursor = byId.get(leafId);
  while (cursor) {
    if (!cursor.id || keepIds.has(cursor.id)) {
      break;
    }
    keepIds.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (keepIds.size === 0) {
    // Leaf not found in file — don't risk truncation.
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const kept: ParsedLine[] = [];
  for (const line of parsed) {
    // Always keep: malformed lines (no parsed id), structural roots (parentId === null).
    // Keep identified entries only if they're on the active leaf chain.
    if (!line.id) {
      kept.push(line);
      continue;
    }
    if (line.parentId === null) {
      kept.push(line);
      continue;
    }
    if (keepIds.has(line.id)) {
      kept.push(line);
    }
  }
  const removed = parsed.length - kept.length;
  if (removed === 0) {
    return { removedEntries: 0, bytesRemoved: 0 };
  }
  const newContent = `${kept.map((l) => l.raw).join("\n")}\n`;
  const originalSize = Buffer.byteLength(content, "utf-8");
  const newSize = Buffer.byteLength(newContent, "utf-8");
  const tmp = `${sessionFile}.leaf-branch-compact.tmp`;
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
      `[transcript-rewrite] leaf-branch compaction write failed: ${formatErrorMessage(err)}`,
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
    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: params.request.replacements,
    });
    if (result.changed) {
      const leafId =
        typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : null;
      const compactResult = compactSessionFileToActiveLeafBranch(params.sessionFile, leafId);
      emitSessionTranscriptUpdate(params.sessionFile);
      log.info(
        `[transcript-rewrite] rewrote ${result.rewrittenEntries} entr` +
          `${result.rewrittenEntries === 1 ? "y" : "ies"} ` +
          `bytesFreed=${result.bytesFreed} ` +
          `leafBranchCompaction=removed:${compactResult.removedEntries}/bytes:${compactResult.bytesRemoved} ` +
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
