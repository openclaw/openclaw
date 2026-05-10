import type {
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../agent-core-contract.js";
import {
  persistTranscriptStateMutationForSession,
  readTranscriptStateForSession,
  type TranscriptState,
} from "../transcript/transcript-state.js";
import { log } from "./logger.js";

type SessionBranchEntry = ReturnType<TranscriptState["getBranch"]>[number];

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

function appendTranscriptStateBranchEntry(params: {
  state: TranscriptState;
  entry: SessionBranchEntry;
  rewrittenEntryIds: ReadonlyMap<string, string>;
}): SessionBranchEntry {
  const { state, entry, rewrittenEntryIds } = params;
  if (entry.type === "message") {
    return state.appendMessage(entry.message);
  }
  if (entry.type === "compaction") {
    return state.appendCompaction(
      entry.summary,
      remapEntryId(entry.firstKeptEntryId, rewrittenEntryIds) ?? entry.firstKeptEntryId,
      entry.tokensBefore,
      entry.details,
      entry.fromHook,
    );
  }
  if (entry.type === "thinking_level_change") {
    return state.appendThinkingLevelChange(entry.thinkingLevel);
  }
  if (entry.type === "model_change") {
    return state.appendModelChange(entry.provider, entry.modelId);
  }
  if (entry.type === "custom") {
    return state.appendCustomEntry(entry.customType, entry.data);
  }
  if (entry.type === "custom_message") {
    return state.appendCustomMessageEntry(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
    );
  }
  if (entry.type === "session_info") {
    return state.appendSessionInfo(entry.name ?? "");
  }
  if (entry.type === "branch_summary") {
    return state.branchWithSummary(
      remapEntryId(entry.parentId, rewrittenEntryIds),
      entry.summary,
      entry.details,
      entry.fromHook,
    );
  }
  return state.appendLabelChange(
    remapEntryId(entry.targetId, rewrittenEntryIds) ?? entry.targetId,
    entry.label,
  );
}

export function rewriteTranscriptEntriesInState(params: {
  state: TranscriptState;
  replacements: TranscriptRewriteReplacement[];
}): TranscriptRewriteResult & { appendedEntries: SessionBranchEntry[] } {
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
      appendedEntries: [],
    };
  }

  const branch = params.state.getBranch();
  if (branch.length === 0) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "empty session",
      appendedEntries: [],
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
      appendedEntries: [],
    };
  }

  const firstMatchedEntry = branch[matchedIndices[0]] as
    | Extract<SessionBranchEntry, { type: "message" }>
    | undefined;
  if (!firstMatchedEntry) {
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: "invalid first rewrite target",
      appendedEntries: [],
    };
  }

  if (!firstMatchedEntry.parentId) {
    params.state.resetLeaf();
  } else {
    params.state.branch(firstMatchedEntry.parentId);
  }

  const appendedEntries: SessionBranchEntry[] = [];
  const rewrittenEntryIds = new Map<string, string>();
  for (let index = matchedIndices[0]; index < branch.length; index++) {
    const entry = branch[index];
    const replacement = entry.type === "message" ? replacementsById.get(entry.id) : undefined;
    const newEntry =
      replacement === undefined
        ? appendTranscriptStateBranchEntry({
            state: params.state,
            entry,
            rewrittenEntryIds,
          })
        : params.state.appendMessage(replacement);
    rewrittenEntryIds.set(entry.id, newEntry.id);
    appendedEntries.push(newEntry);
  }

  return {
    changed: true,
    bytesFreed,
    rewrittenEntries: matchedIndices.length,
    appendedEntries,
  };
}

/**
 * Rewrite message entries on the active SQLite transcript branch and emit a
 * transcript update when the active branch changed.
 */
export async function rewriteTranscriptEntriesInSqliteTranscript(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  request: TranscriptRewriteRequest;
  config?: unknown;
}): Promise<TranscriptRewriteResult> {
  try {
    const state = await readTranscriptStateForSession({
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
    const result = rewriteTranscriptEntriesInState({
      state,
      replacements: params.request.replacements,
    });
    if (result.changed) {
      await persistTranscriptStateMutationForSession({
        agentId: params.agentId,
        sessionId: params.sessionId,
        state,
        appendedEntries: result.appendedEntries,
      });
      emitSessionTranscriptUpdate({
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
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
  }
}
