import type { RestartRecoveryRun } from "../../config/sessions.js";
import { readSessionSubmittedRunInputInWorker } from "../../config/sessions/session-submitted-input.js";
import {
  readSessionTranscriptSummaryAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import {
  readUserTurnForegroundOnlyLifecycleGeneration,
  readUserTurnForegroundOnlyRunId,
} from "../../sessions/user-turn-transcript.metadata.js";

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope & { agentId: string; sessionKey: string },
  sourceRunId?: string,
  restartSources: readonly RestartRecoveryRun[] = [],
) {
  const { checkpoint } = await readSessionTranscriptSummaryAsync(scope, {
    kind: "recovery-checkpoint",
    sourceRunId,
    restartSourceRunIds: restartSources.map((run) => run.runId),
  });
  const {
    replaySafe,
    source,
    sourceForegroundOnlyRunId,
    latestForegroundOnlyRunId,
    latestMatchesRestartSource,
  } = checkpoint;
  let foregroundOnlyRunId =
    sourceForegroundOnlyRunId === undefined
      ? restartSources.length === 0 || latestMatchesRestartSource
        ? latestForegroundOnlyRunId
        : undefined
      : (sourceForegroundOnlyRunId ?? undefined);
  if (
    sourceForegroundOnlyRunId === undefined &&
    (sourceRunId !== undefined || !latestMatchesRestartSource)
  ) {
    // Shutdown can fence registered work before its accepted input is promoted.
    // Resolve those exact sources; a queued caller cannot replace a different
    // active source already identified in the transcript or delivery claim.
    const sources = sourceRunId
      ? [{ runId: sourceRunId, lifecycleGeneration: undefined }]
      : restartSources;
    for (const run of sources) {
      const input = await readSessionSubmittedRunInputInWorker(scope, run.runId);
      const restrictedRunId = readUserTurnForegroundOnlyRunId(input);
      if (sourceRunId && input && !restrictedRunId) {
        foregroundOnlyRunId = undefined;
        break;
      }
      if (
        restrictedRunId &&
        (run.lifecycleGeneration === undefined ||
          readUserTurnForegroundOnlyLifecycleGeneration(input) === run.lifecycleGeneration)
      ) {
        foregroundOnlyRunId = restrictedRunId;
        break;
      }
    }
  }
  return {
    foregroundOnly: foregroundOnlyRunId !== undefined,
    foregroundOnlyRunId,
    replaySafe,
    source,
  };
}
