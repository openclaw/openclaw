import crypto from "node:crypto";
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

/**
 * Stable identity key for suppressing duplicate re-appends during transcript
 * rewrite / overflow-recovery replay.
 *
 * Invariant (#66443, refs #69208): replaying a session suffix must not persist
 * two identity-equal entries (duplicate role=user messages, cloned compaction
 * entries, repeated openclaw:bootstrap-context:full custom entries). We key on
 * intrinsic content rather than the per-entry `id` because re-append assigns
 * fresh ids on every replay. Returns `null` for entry kinds that are inherently
 * unique-per-id (labels, branch summaries, session_info) so they pass through.
 */
function computeBranchEntryDedupeKey(entry: SessionBranchEntry): string | null {
  const sha = (value: unknown) =>
    crypto
      .createHash("sha256")
      .update(JSON.stringify(value ?? null))
      .digest("hex");
  if (entry.type === "message") {
    const message = entry.message as { role: string; content?: unknown };
    return `message:${message.role}:${sha(message.content)}`;
  }
  if (entry.type === "compaction") {
    return `compaction:${entry.tokensBefore}:${entry.firstKeptEntryId}:${sha(entry.summary)}`;
  }
  if (entry.type === "custom") {
    return `custom:${entry.customType}:${sha(entry.data)}`;
  }
  if (entry.type === "custom_message") {
    return `custom_message:${entry.customType}:${sha(entry.content)}`;
  }
  return null;
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
  // Idempotency invariant for #66443: suppress identity-equal duplicates inside
  // the replayed suffix (duplicate role=user messages, cloned compactions,
  // repeated openclaw:bootstrap-context:full custom entries). User-requested
  // replacements are always emitted; they define the rewrite intent.
  const seenIdentities = new Map<string, string>();
  for (let index = matchedIndices[0]; index < branch.length; index++) {
    const entry = branch[index];
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    if (replacement === undefined) {
      const dedupeKey = computeBranchEntryDedupeKey(entry);
      if (dedupeKey !== null) {
        const priorEmittedId = seenIdentities.get(dedupeKey);
        if (priorEmittedId !== undefined) {
          // Skip the duplicate but keep the id remap chain intact so any
          // downstream entry referencing this entry's id resolves to the
          // previously-emitted equivalent.
          rewrittenEntryIds.set(entry.id, priorEmittedId);
          continue;
        }
      }
      const newEntryId = appendBranchEntry({
        sessionManager: params.sessionManager,
        entry,
        rewrittenEntryIds,
        appendMessage,
      });
      rewrittenEntryIds.set(entry.id, newEntryId);
      if (dedupeKey !== null) {
        seenIdentities.set(dedupeKey, newEntryId);
      }
    } else {
      const newEntryId = appendMessage(
        replacement as Parameters<typeof params.sessionManager.appendMessage>[0],
      );
      rewrittenEntryIds.set(entry.id, newEntryId);
      // Seed dedupe with the replacement's identity so identity-equal suffix
      // duplicates collapse against the user-requested rewrite (#66443).
      const replacementKey = computeBranchEntryDedupeKey({
        ...entry,
        message: replacement,
      } as SessionBranchEntry);
      if (replacementKey !== null) {
        seenIdentities.set(replacementKey, newEntryId);
      }
    }
  }

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
  };
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
      emitSessionTranscriptUpdate(params.sessionFile);
      log.info(
        `[transcript-rewrite] rewrote ${result.rewrittenEntries} entr` +
          `${result.rewrittenEntries === 1 ? "y" : "ies"} ` +
          `bytesFreed=${result.bytesFreed} ` +
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
