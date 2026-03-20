import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { log } from "./logger.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionBranchEntry = ReturnType<SessionManagerLike["getBranch"]>[number];

function estimateMessageBytes(message: AgentMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function appendBranchEntry(sessionManager: SessionManagerLike, entry: SessionBranchEntry): void {
  if (entry.type === "message") {
    sessionManager.appendMessage(
      entry.message as Parameters<typeof sessionManager.appendMessage>[0],
    );
    return;
  }
  if (entry.type === "compaction") {
    sessionManager.appendCompaction(
      entry.summary,
      entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
    );
    return;
  }
  if (entry.type === "thinking_level_change") {
    sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
    return;
  }
  if (entry.type === "model_change") {
    sessionManager.appendModelChange(entry.provider, entry.modelId);
    return;
  }
  if (entry.type === "custom") {
    sessionManager.appendCustomEntry(entry.customType, entry.data);
    return;
  }
  if (entry.type === "custom_message") {
    sessionManager.appendCustomMessageEntry(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
    );
    return;
  }
  if (entry.type === "session_info") {
    if (entry.name) {
      sessionManager.appendSessionInfo(entry.name);
    }
    return;
  }
  if (entry.type === "branch_summary" || entry.type === "label") {
    // These entries reference branch-specific ids and cannot be replayed safely.
    return;
  }
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

  const firstMatchedEntry = branch[matchedIndices[0]];
  if (!firstMatchedEntry || firstMatchedEntry.type !== "message") {
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

  for (let index = matchedIndices[0]; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "message") {
      appendBranchEntry(params.sessionManager, entry);
      continue;
    }
    const replacement = replacementsById.get(entry.id);
    if (replacement) {
      params.sessionManager.appendMessage(
        replacement as Parameters<typeof params.sessionManager.appendMessage>[0],
      );
      continue;
    }
    appendBranchEntry(params.sessionManager, entry);
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
  try {
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
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[transcript-rewrite] failed: ${reason}`);
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason,
    };
  }
}
