import { normalizeInputProvenance } from "../../../sessions/input-provenance.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import type {
  SessionEntry as SessionManagerEntry,
  SessionMessageEntry,
} from "../../sessions/index.js";
import { isSessionContextMetadataEntry } from "../../sessions/session-manager-codec.js";
import { mergeOrphanedTrailingUserPrompt } from "./attempt-prompt-helpers.js";

type OrphanRepairSessionManager = {
  getLeafEntry: () => SessionManagerEntry | undefined;
  getEntry: (entryId: string) => SessionManagerEntry | undefined;
  hasLoadedTranscriptTail: (entryId: string, parentId: string | null) => boolean;
  appendThinkingLevelChange: (thinkingLevel: string) => Promise<string>;
  appendModelChange: (provider: string, modelId: string) => Promise<string>;
  appendCustomEntryAsync: (customType: string, data?: unknown) => Promise<string>;
  appendSessionInfoAsync: (name: string) => Promise<string>;
  appendLabelChangeAsync: (targetId: string, label?: string) => Promise<string>;
};

type OrphanRepairCandidate = {
  messageEntry: SessionMessageEntry;
  trailingEntries: SessionManagerEntry[];
};

function findTrailingMessageEntryForOrphanRepair(
  sessionManager: OrphanRepairSessionManager,
): OrphanRepairCandidate | undefined {
  const visited = new Set<string>();
  const trailingEntries: SessionManagerEntry[] = [];
  let entry = sessionManager.getLeafEntry();
  while (entry && isSessionContextMetadataEntry(entry)) {
    if (visited.has(entry.id)) {
      return undefined;
    }
    visited.add(entry.id);
    trailingEntries.push(entry);
    entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
  }
  return entry?.type === "message"
    ? { messageEntry: entry, trailingEntries: trailingEntries.toReversed() }
    : undefined;
}

export async function replayTrailingEntriesForOrphanRepair(
  sessionManager: OrphanRepairSessionManager,
  trailingEntries: SessionManagerEntry[],
): Promise<void> {
  const replayedEntryIds = new Map<string, string>();
  for (const entry of trailingEntries) {
    let replayedId: string;
    switch (entry.type) {
      case "thinking_level_change":
        replayedId = await sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
        break;
      case "model_change":
        replayedId = await sessionManager.appendModelChange(entry.provider, entry.modelId);
        break;
      case "custom":
        replayedId = await sessionManager.appendCustomEntryAsync(entry.customType, entry.data);
        break;
      case "session_info":
        replayedId = await sessionManager.appendSessionInfoAsync(entry.name ?? "");
        break;
      case "label": {
        const replayedTargetId = replayedEntryIds.get(entry.targetId);
        if (!replayedTargetId && !sessionManager.getEntry(entry.targetId)) {
          continue;
        }
        replayedId = await sessionManager.appendLabelChangeAsync(
          replayedTargetId ?? entry.targetId,
          entry.label,
        );
        break;
      }
      default:
        continue;
    }
    replayedEntryIds.set(entry.id, replayedId);
  }
}

type OrphanRepairPlan = Omit<OrphanRepairCandidate, "messageEntry"> & {
  contextEnginePrompt: string;
  messageEntry: SessionMessageEntry & { message: PersistedUserTurnMessage };
  removeLeaf: boolean;
  /** The preserved leaf already stores the merged text, so the new durable row must not repeat it. */
  durableLeafCarriesMergedText: boolean;
};

function isUserSessionMessageEntry(
  entry: SessionMessageEntry,
): entry is SessionMessageEntry & { message: PersistedUserTurnMessage } {
  return entry.message.role === "user";
}

/** Chat input authored by this session's own user, not an internal or cross-session handoff. */
function isExternalUserOrphan(provenance: unknown): boolean {
  // An unrecognized provenance kind (realtime voice, host sentinels) is not chat input.
  if (provenance === undefined || provenance === null) {
    return true;
  }
  return normalizeInputProvenance(provenance)?.kind === "external_user";
}

/**
 * Durable text for a repaired turn.
 *
 * A removed leaf has to carry its text in the replacement row. A preserved external leaf already
 * stores that text as a visible history row, so repeating it would show the same message twice.
 */
export function resolveOrphanRepairTranscriptPrompt(params: {
  transcriptPrompt: string;
  leafMessage: PersistedUserTurnMessage;
  durableLeafCarriesMergedText: boolean;
}): string {
  if (params.durableLeafCarriesMergedText) {
    return params.transcriptPrompt;
  }
  return mergeOrphanedTrailingUserPrompt({
    prompt: params.transcriptPrompt,
    leafMessage: params.leafMessage,
  }).prompt;
}

export function resolveOrphanRepairPlan(params: {
  sessionManager: OrphanRepairSessionManager;
  prompt: string;
  preserveLeaf: boolean;
  /** This turn already wrote its own canonical row, so a differing leaf is stale and must go. */
  currentTurnPersisted: boolean;
}): OrphanRepairPlan | undefined {
  const candidate = findTrailingMessageEntryForOrphanRepair(params.sessionManager);
  if (
    !candidate ||
    !isUserSessionMessageEntry(candidate.messageEntry) ||
    !params.sessionManager.hasLoadedTranscriptTail(
      candidate.messageEntry.id,
      candidate.messageEntry.parentId,
    )
  ) {
    return undefined;
  }
  const merge = mergeOrphanedTrailingUserPrompt({
    prompt: params.prompt,
    leafMessage: candidate.messageEntry.message,
  });
  // The merged prompt already carries this external user's text, so the durable row can stay:
  // rewinding it would hide an accepted message from history and publish a leaf control, which
  // marks the whole transcript index for a full rebuild before this run may continue.
  const keepMergedExternalLeaf =
    merge.merged &&
    !params.preserveLeaf &&
    // This turn still writes its own canonical row after the preserved leaf; an already
    // persisted row means the leaf is stale and the repair has to replace it.
    !params.currentTurnPersisted &&
    // A preserved leaf is dropped from this call's provider prefix by position, so it has to be
    // the context tail; excluded rows are invisible to that context and must keep the old repair.
    candidate.messageEntry.message.excludeFromContext !== true &&
    isExternalUserOrphan(candidate.messageEntry.message.provenance);
  return {
    contextEnginePrompt: merge.prompt,
    messageEntry: candidate.messageEntry,
    trailingEntries: candidate.trailingEntries,
    removeLeaf: keepMergedExternalLeaf ? false : merge.removeLeaf || !params.preserveLeaf,
    durableLeafCarriesMergedText: keepMergedExternalLeaf,
  };
}
