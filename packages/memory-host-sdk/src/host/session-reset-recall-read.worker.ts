import { readTranscriptExportSnapshotReadOnlySync } from "../../../../src/config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSessionResetRecallCutoff,
  type SessionResetRecallCutoff,
} from "./session-reset-recall.js";

export type SessionResetRecallScope = {
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
