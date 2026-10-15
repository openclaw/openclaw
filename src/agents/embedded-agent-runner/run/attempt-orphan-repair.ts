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
};

function isUserSessionMessageEntry(
  entry: SessionMessageEntry,
): entry is SessionMessageEntry & { message: PersistedUserTurnMessage } {
  return entry.message.role === "user";
}

export function resolveOrphanRepairPlan(params: {
  sessionManager: OrphanRepairSessionManager;
  prompt: string;
  preserveLeaf: boolean;
}): OrphanRepairPlan | undefined {
  const candidate = findTrailingMessageEntryForOrphanRepair(params.sessionManager);
  if (!candidate || !isUserSessionMessageEntry(candidate.messageEntry)) {
    return undefined;
  }
  const merge = mergeOrphanedTrailingUserPrompt({
    prompt: params.prompt,
    leafMessage: candidate.messageEntry.message,
  });
  return {
    contextEnginePrompt: merge.prompt,
    messageEntry: candidate.messageEntry,
    trailingEntries: candidate.trailingEntries,
    removeLeaf: merge.removeLeaf || !params.preserveLeaf,
  };
}
