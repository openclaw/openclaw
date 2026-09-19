/** Owns the shared checkpoint lifecycle around both compaction entry points. */
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import {
  persistSessionCompactionCheckpoint,
  readSessionLeafStateFromTranscriptAsync,
  resolveCompactionCheckpointTranscriptPosition,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { log } from "./logger.js";

export {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";

export async function persistCompactionCheckpoint(params: {
  sessionTarget: SessionTranscriptRuntimeTarget;
  trigger?: "budget" | "overflow" | "manual";
  snapshot?: CapturedCompactionCheckpointSnapshot | null;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  leafId?: string;
  createdAt?: number;
}): Promise<boolean> {
  if (!params.snapshot) {
    return false;
  }
  try {
    const transcriptState = await readSessionLeafStateFromTranscriptAsync(params.sessionTarget);
    const checkpointPosition = resolveCompactionCheckpointTranscriptPosition({
      preferredLeafId: params.leafId,
      transcriptState,
    });
    const stored = await persistSessionCompactionCheckpoint({
      sessionTarget: params.sessionTarget,
      reason: resolveSessionCompactionCheckpointReason({ trigger: params.trigger }),
      snapshot: params.snapshot,
      summary: params.summary,
      firstKeptEntryId: params.firstKeptEntryId,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      // Keep the full successor location for cross-key/store checkpoint recovery.
      postSessionFile: formatSqliteSessionFileMarker(params.sessionTarget),
      postLeafId: checkpointPosition.leafId,
      postEntryId: checkpointPosition.entryId,
      createdAt: params.createdAt,
    });
    return stored !== null;
  } catch (err) {
    log.warn("failed to persist compaction checkpoint", {
      errorMessage: formatErrorMessage(err),
    });
    return false;
  }
}
