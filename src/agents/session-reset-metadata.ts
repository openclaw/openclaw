import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAllCliSessions } from "./cli-session.js";
import { transitionMainSessionRecovery } from "./main-session-recovery/main-session-recovery-state.js";

export function clearRotatedSessionMetadata(entry: InternalSessionEntry): InternalSessionEntry {
  const next = {
    ...entry,
    ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
    sessionFile: undefined,
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    abortedLastRun: undefined,
    restartRecoveryTerminalDeliveryEvidence: undefined,
    restartRecoveryTerminalRunIds: undefined,
    sessionStartedAt: undefined,
    sessionDiffBaseline: undefined,
    sessionDiffBaselineCapture: undefined,
    lastInteractionAt: undefined,
    pendingTranscriptRepair: undefined,
  };
  transitionMainSessionRecovery(next, { kind: "clear" });
  clearAllCliSessions(next);
  return next;
}
