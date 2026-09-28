import {
  isIncognitoOpenClawAgentSqlitePath,
  isIncognitoSessionKey,
  readRestoredSessionTranscript,
  readSessionResetRecallCutoffInWorker,
  readTranscriptExportSnapshotReadOnlySync,
  SessionTranscriptColdError,
} from "./openclaw-runtime-session.js";
import {
  resolveSessionResetRecallCutoff,
  type SessionResetRecallCutoff,
} from "./session-reset-recall.js";

type SessionResetRecallScope = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
};

/** Read only reset navigation; transcript bodies are irrelevant to recall visibility. */
export function readSessionResetRecallCutoffInProcess(
  scope: SessionResetRecallScope,
): SessionResetRecallCutoff {
  const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, {
    projection: "reset-boundary",
  });
  return snapshot ? resolveSessionResetRecallCutoff(snapshot.events) : { state: "invalid" };
}

export async function readSessionResetRecallCutoff(
  scope: SessionResetRecallScope,
): Promise<SessionResetRecallCutoff> {
  const read = () =>
    isIncognitoSessionKey(scope.sessionKey) ||
    isIncognitoOpenClawAgentSqlitePath(scope.storePath, { agentId: scope.agentId })
      ? readSessionResetRecallCutoffInProcess(scope)
      : readSessionResetRecallCutoffInWorker(scope);
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    return readRestoredSessionTranscript(scope, read);
  }
}
