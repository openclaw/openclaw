import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { isMainSessionCurrentGenerationStop } from "../../config/sessions/restart-recovery-current-generation-stop.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";

export { isMainSessionCurrentGenerationStop };

/** A main-session claim that outlived its run and may open or join a restart recovery cycle. */
export function isMainSessionRestartInterruptedClaim(
  entry: SessionEntry,
  scope: { sessionKey: string; lifecycleGeneration: string },
): boolean {
  return (
    hasMainSessionRecoveryClaim(entry) &&
    entry.abortedLastRun === true &&
    isMainRestartRecoveryCandidate(entry, scope.sessionKey) &&
    !isMainSessionCurrentGenerationStop(entry, scope.lifecycleGeneration)
  );
}
