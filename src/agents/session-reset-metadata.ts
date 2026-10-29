import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAllCliSessions } from "./cli-session.js";

export function clearRotatedSessionMetadata(entry: InternalSessionEntry): InternalSessionEntry {
  const next = {
    ...entry,
    sessionFile: undefined,
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    abortedLastRun: undefined,
    resumeAfterRestart: undefined,
    sessionStartedAt: undefined,
    sessionDiffBaseline: undefined,
    sessionDiffBaselineCapture: undefined,
    lastInteractionAt: undefined,
    pendingTranscriptRepair: undefined,
  };
  clearAllCliSessions(next);
  return next;
}
