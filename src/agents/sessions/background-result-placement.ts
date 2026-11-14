import {
  BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
  isPendingBackgroundResultMessage,
  projectPlacedBackgroundResultMessage,
  readBackgroundResultPlacement,
} from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { sameSessionTranscriptStorePath } from "../../config/sessions/transcript-store-identity.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "./session-manager-types.js";
import { runSessionManagerWrite } from "./session-manager-write-admission.js";
import type { SessionManager } from "./session-manager.js";

/** The request boundary consumes only recorded result placements, never a reloaded user turn. */
export function createBackgroundResultPlacement(manager: SessionManager) {
  let inspectedId: string | null = null;
  const pending = new Map<string, AgentMessage>();
  const accepted = new Set<string>();
  const dispose = onInternalSessionTranscriptUpdate((update) => {
    if (!update.messageId || !isPendingBackgroundResultMessage(update.message)) {
      return;
    }
    const target = manager.getSessionTarget();
    if (
      target &&
      update.target &&
      update.target.agentId === target.agentId &&
      update.target.sessionId === target.sessionId &&
      sameSessionTranscriptStorePath(update.target.storePath, target.storePath)
    ) {
      accepted.add(update.messageId);
    }
  });
  const beforeRequest = async (signal?: AbortSignal): Promise<AgentMessage[] | undefined> => {
    signal?.throwIfAborted();
    return runSessionManagerWrite(manager, async () => {
      if ([...accepted].some((id) => !manager.getEntry(id))) {
        // Ordinary message appends usually adopted these already. Idle continuation has no append.
        await manager.reloadPersistedTranscriptAsync(signal);
      }
      accepted.clear();
      const entries: SessionEntry[] = [];
      let id = manager.getLeafId();
      while (id && id !== inspectedId) {
        const entry = manager.getEntry(id);
        if (!entry) {
          break;
        }
        entries.push(entry);
        id = entry.parentId;
      }
      if (id !== inspectedId) {
        // Navigation or compaction changed the branch; only its retained pending entries apply.
        pending.clear();
      }
      inspectedId = manager.getLeafId();
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (entry.type === "reset" || entry.type === "branch_summary") {
          pending.clear();
        }
        if (entry.type === "message" && isPendingBackgroundResultMessage(entry.message)) {
          pending.set(entry.id, entry.message);
        }
        const placement = readBackgroundResultPlacement(entry);
        for (const resultId of placement?.resultEntryIds ?? []) {
          pending.delete(resultId);
        }
      }
      if (pending.size === 0) {
        return undefined;
      }
      signal?.throwIfAborted();
      const resultEntryIds = [...pending.keys()];
      const markerId = await manager.appendCustomEntryAsync(
        BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
        { afterEntryId: manager.getAppendParentId(), resultEntryIds },
      );
      const placement = readBackgroundResultPlacement(manager.getEntry(markerId));
      if (!placement) {
        throw new Error("Committed background result placement is unavailable");
      }
      // Keep the old cursor: the append can also adopt newer, still-unplaced results.
      return placement.resultEntryIds.map((resultId) => {
        const message = pending.get(resultId);
        if (!message) {
          throw new Error("Committed background result payload is unavailable");
        }
        pending.delete(resultId);
        return projectPlacedBackgroundResultMessage(message);
      });
    });
  };
  return { beforeRequest, dispose };
}
