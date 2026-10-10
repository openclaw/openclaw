/** Rewrites transcript entries by branching and re-appending the active suffix. */
import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { withSessionPendingInputRelocation } from "../../config/sessions/session-accessor.js";
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { getRawSessionAppendMessageAsync } from "../session-raw-append-message.js";
import type { SessionManager } from "../sessions/session-manager.js";

type SessionBranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type RewriteMessageAppender = (
  message: Parameters<SessionManager["appendMessageAsync"]>[0],
) => Promise<string>;

function stripStalePrefixReplay(message: AgentMessage): AgentMessage {
  return message.role === "assistant" ? stripCompactionReplayCheckpoint(message) : message;
}

function unchangedRewrite(reason: string): TranscriptRewriteResult {
  return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason };
}

function findTranscriptRewriteMatches(
  branch: readonly SessionBranchEntry[],
  replacementsById: ReadonlyMap<string, AgentMessage>,
): { matchedIndices: number[]; bytesFreed: number } {
  const matchedIndices: number[] = [];
  let bytesFreed = 0;

  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") {
      continue;
    }
    const replacement = replacementsById.get(entry.id);
    if (!replacement) {
      continue;
    }
    const originalJson = JSON.stringify(entry.message);
    const replacementJson = JSON.stringify(replacement);
    if (originalJson === replacementJson) {
      continue;
    }
    matchedIndices.push(index);
    bytesFreed += Math.max(0, Buffer.byteLength(originalJson) - Buffer.byteLength(replacementJson));
  }

  return { matchedIndices, bytesFreed };
}

function remapEntryId(
  entryId: string | null | undefined,
  rewrittenEntryIds: ReadonlyMap<string, string>,
): string | null {
  return entryId ? (rewrittenEntryIds.get(entryId) ?? entryId) : null;
}

async function appendBranchEntry(params: {
  sessionManager: SessionManager;
  entry: SessionBranchEntry;
  rewrittenEntryIds: ReadonlyMap<string, string>;
  appendMessage: RewriteMessageAppender;
  replacement?: AgentMessage;
}): Promise<string> {
  const { sessionManager, entry, rewrittenEntryIds, appendMessage } = params;
  switch (entry.type) {
    case "message": {
      const message = (
        params.replacement === undefined
          ? stripStalePrefixReplay(entry.message)
          : params.replacement
      ) as Parameters<typeof sessionManager.appendMessage>[0];
      return withSessionPendingInputRelocation(entry.id, message, () => appendMessage(message));
    }
    case "compaction": {
      const { __openclaw: identity } = entry;
      return sessionManager.appendCompactionAsync(
        entry.summary,
        remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
        entry.tokensBefore,
        entry.details,
        entry.fromHook,
        // An unknown historical run must not inherit the rewriting run's identity.
        { runId: identity?.runId, ...identity },
        entry.tokensAfter,
      );
    }
    case "reset":
      return sessionManager.appendResetBoundaryAsync(
        entry.reason,
        entry.firstKeptEntryId
          ? (remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId)
          : undefined,
      );
    case "thinking_level_change":
      return sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
    case "model_change":
      return sessionManager.appendModelChange(entry.provider, entry.modelId);
    case "custom":
      return sessionManager.appendCustomEntryAsync(entry.customType, entry.data);
    case "custom_message":
      return sessionManager.appendCustomMessageEntryAsync(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
      );
    case "session_info":
      return sessionManager.appendSessionInfoAsync(entry.name || "");
    case "branch_summary":
      return sessionManager.branchWithSummaryAsync(
        remapEntryId(entry.parentId, rewrittenEntryIds),
        entry.summary,
        entry.details,
        entry.fromHook,
      );
    default:
      return sessionManager.appendLabelChangeAsync(
        remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId,
        entry.label,
      );
  }
}

/**
 * Safely rewrites transcript message entries on the active branch by branching
 * from the first rewritten message's parent and re-appending the suffix.
 */
export async function rewriteTranscriptEntriesInSessionManager(params: {
  sessionManager: SessionManager;
  replacements: TranscriptRewriteReplacement[];
  /** Preserve a checkpoint freshly captured on an explicit replacement. */
  preserveReplacementCompactionReplay?: boolean;
}): Promise<TranscriptRewriteResult> {
  const replacementsById = new Map(
    params.replacements
      .filter((replacement) => replacement.entryId.trim().length > 0)
      .map((replacement) => [
        replacement.entryId,
        params.preserveReplacementCompactionReplay
          ? replacement.message
          : stripStalePrefixReplay(replacement.message),
      ]),
  );
  if (replacementsById.size === 0) {
    return unchangedRewrite("no replacements requested");
  }

  const activeBranch = params.sessionManager.getBranch();
  if (activeBranch.length === 0) {
    return unchangedRewrite("empty session");
  }

  const { matchedIndices, bytesFreed } = findTranscriptRewriteMatches(
    activeBranch,
    replacementsById,
  );

  if (matchedIndices.length === 0) {
    return unchangedRewrite("no changed matching message entries");
  }

  const rewrite = await params.sessionManager.prepareTranscriptRewriteAsync();
  const rewriteManager = rewrite.sessionManager;
  const branch = rewriteManager.getBranch();
  if (
    branch.length !== activeBranch.length ||
    branch.some((entry, index) => entry.id !== activeBranch[index]?.id)
  ) {
    throw new Error("Session transcript changed before rewrite preparation");
  }

  const firstMatchedIndex = matchedIndices.at(0);
  const firstMatchedEntry =
    firstMatchedIndex === undefined ? undefined : branch.at(firstMatchedIndex);
  // matchedIndices only contains indices of branch "message" entries.
  if (!firstMatchedEntry || firstMatchedEntry.type !== "message") {
    return unchangedRewrite("invalid first rewrite target");
  }

  if (!firstMatchedEntry.parentId) {
    await rewriteManager.resetLeafAsync();
  } else {
    await rewriteManager.branchAsync(firstMatchedEntry.parentId);
  }

  // Maintenance rewrites should preserve the exact requested history without
  // re-running persistence hooks or size truncation on replayed messages.
  const rawAppendMessage = getRawSessionAppendMessageAsync(rewriteManager);
  // Deliberate copies retain ingress keys without adopting their old branch entries.
  const appendMessage: RewriteMessageAppender = async (message) => {
    const entryId = await rawAppendMessage(message, { idempotencyLookup: "caller-checked" });
    if (entryId === undefined) {
      throw new Error("Transcript rewrite message was not appended");
    }
    return entryId;
  };
  const rewrittenEntryIds = new Map<string, string>();
  // Every re-appended message follows the rewritten prefix, so its prefix-bound checkpoint is stale.
  for (const entry of branch.slice(firstMatchedIndex)) {
    const newEntryId = await appendBranchEntry({
      sessionManager: rewriteManager,
      entry,
      rewrittenEntryIds,
      appendMessage,
      replacement: entry.type === "message" ? replacementsById.get(entry.id) : undefined,
    });
    rewrittenEntryIds.set(entry.id, newEntryId);
  }

  await rewrite.commit(rewrittenEntryIds);

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
  };
}
