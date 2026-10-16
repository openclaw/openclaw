import { isDeepStrictEqual } from "node:util";
import { advanceHarnessCompletionClaim } from "../config/sessions/harness-completion-compaction.js";
import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

/** Snapshot owned by admission, never the post-run cache. */
export type PendingFinalRecoverySource = Readonly<
  Pick<
    SessionEntry,
    | "sessionId"
    | "lifecycleRevision"
    | "restartRecoveryDeliveryRunId"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryContext"
    | "restartRecoveryHarnessCompletion"
  >
>;

export function capturePendingFinalRecoverySource(
  entry: SessionEntry | undefined,
): PendingFinalRecoverySource | undefined {
  if (!entry) {
    return undefined;
  }
  return freezeJsonSnapshot(
    structuredClone({
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryDeliveryContext: entry.restartRecoveryDeliveryContext,
      restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion,
    }),
  );
}

/** Advance only identity, through the exact committed chain; original source/route stay frozen. */
export function advancePendingFinalRecoverySource(
  admitted: PendingFinalRecoverySource,
  transitions: readonly SessionAdmissionTransition[] = [],
): PendingFinalRecoverySource | undefined {
  let { sessionId, lifecycleRevision, restartRecoveryHarnessCompletion } = admitted;
  for (const transition of transitions) {
    if (
      !transition.previous ||
      transition.previous.sessionId !== sessionId ||
      transition.previous.lifecycleRevision !== lifecycleRevision
    ) {
      return undefined;
    }
    if (restartRecoveryHarnessCompletion) {
      restartRecoveryHarnessCompletion = advanceHarnessCompletionClaim(
        restartRecoveryHarnessCompletion,
        transition,
      );
      if (!restartRecoveryHarnessCompletion) {
        return undefined;
      }
    }
    ({ sessionId, lifecycleRevision } = transition.current);
  }
  return {
    ...admitted,
    sessionId,
    lifecycleRevision,
    restartRecoveryHarnessCompletion,
  };
}

export function matchesPendingFinalRecoverySource(
  current: SessionEntry,
  admitted: PendingFinalRecoverySource,
  transitions: readonly SessionAdmissionTransition[] = [],
): boolean {
  return isDeepStrictEqual(
    capturePendingFinalRecoverySource(current),
    advancePendingFinalRecoverySource(admitted, transitions),
  );
}
