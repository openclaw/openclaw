/** Repairs persisted provider replay state after provider-confirmed rejection. */
import {
  isCompactionReplayCheckpoint,
  stripCompactionReplayCheckpoint,
  type CompactionReplayRejection,
} from "@openclaw/ai/transports";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { AgentMessage } from "../runtime/index.js";
import { log } from "./logger.js";
import { stripThinkingBlocksFromMessage } from "./thinking.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

type RewritableSessionManager = Parameters<
  typeof rewriteTranscriptEntriesInSessionManager
>[0]["sessionManager"];

type ReplayRepairParams = {
  sessionManager: RewritableSessionManager;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
};

type ReplayRepairResult = { repaired: boolean; repairedCount: number; reason?: string };

async function rewriteRejectedReplayInSessionManager(
  params: ReplayRepairParams,
  repair: {
    replacements: Array<{ entryId: string; message: AgentMessage }>;
    emptyReason: string;
    logMessage: string;
  },
): Promise<ReplayRepairResult> {
  if (repair.replacements.length === 0) {
    return { repaired: false, repairedCount: 0, reason: repair.emptyReason };
  }
  const rewriteResult = await rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements: repair.replacements,
  });
  if (!rewriteResult.changed) {
    return { repaired: false, repairedCount: 0, reason: rewriteResult.reason };
  }
  const target = params.sessionManager.getSessionTarget();
  if (target || params.sessionFile) {
    emitSessionTranscriptUpdate({
      ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
      ...(target
        ? { target }
        : {
            sessionKey: params.sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          }),
    });
  }
  log.warn(
    `[session-recovery] ${repair.logMessage}: repaired=${rewriteResult.rewrittenEntries} ` +
      `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );
  return {
    repaired: true,
    repairedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

export function repairRejectedThinkingReplayInSessionManager(
  params: ReplayRepairParams,
): Promise<ReplayRepairResult> {
  const replacements = params.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }
    const replacement = stripThinkingBlocksFromMessage(entry.message);
    return replacement === entry.message ? [] : [{ entryId: entry.id, message: replacement }];
  });

  return rewriteRejectedReplayInSessionManager(params, {
    replacements,
    emptyReason: "no thinking blocks on active branch",
    logMessage: "stripped thinking blocks after provider rejected replay",
  });
}

export function repairRejectedCompactionReplayInSessionManager(
  params: ReplayRepairParams & { checkpoint: CompactionReplayRejection },
): Promise<ReplayRepairResult> {
  const owner = params.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        isCompactionReplayCheckpoint(entry.message.providerReplay) &&
        entry.message.providerReplay.data === params.checkpoint.data &&
        (params.checkpoint.id === undefined ||
          entry.message.providerReplay.id === params.checkpoint.id),
    );
  const replacements =
    owner?.type === "message" && owner.message.role === "assistant"
      ? [
          {
            entryId: owner.id,
            message: stripCompactionReplayCheckpoint(owner.message) as AgentMessage,
          },
        ]
      : [];
  return rewriteRejectedReplayInSessionManager(params, {
    replacements,
    emptyReason: "no matching compaction checkpoint on active branch",
    logMessage: "stripped compaction checkpoint after provider rejected replay",
  });
}
