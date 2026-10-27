import { getMainSessionRecoveryRetryCount } from "./main-session-recovery-state.js";
import { resumeMainSession } from "./main-session-restart-dispatch.js";
import type { ResumeMainSessionParams } from "./main-session-restart-dispatch.types.js";
import type {
  MainSessionRecoveryDecision,
  MainSessionRecoverySkipReason,
} from "./main-session-restart-recovery-diagnostics.js";
import { loadExpectedRestartRecoveryTarget } from "./main-session-restart-recovery-exact-target.js";
import {
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  type ExhaustedRestartRecoveryTarget,
} from "./main-session-restart-recovery-shared.js";

export type RecoveryCounts = { started: number; settled: number; failed: number; skipped: number };

/** Own a prepared dispatch through its admission outcome, independently of the store scan. */
export async function dispatchPreparedMainSessionRecovery(
  params: ResumeMainSessionParams & {
    handledSessionKeys: Set<string>;
    resumeDedupeKey: string;
    onDecision: (decision: MainSessionRecoveryDecision) => void;
    onSkipped?: (reason: MainSessionRecoverySkipReason) => void;
    onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  },
): Promise<RecoveryCounts> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  let decision: MainSessionRecoveryDecision = {
    decision: "deferred",
    reason: "dispatch_failed",
    nextOwner: "main-session-recovery",
  };
  try {
    const outcome = await resumeMainSession(params);
    decision = {
      decision: outcome === "failed" || outcome === "skipped" ? "deferred" : outcome,
      reason: `dispatch_${outcome}`,
      nextOwner:
        outcome === "started"
          ? `${params.lane ?? "restart-recovery"}-lane`
          : outcome === "settled"
            ? "none"
            : "main-session-recovery",
    };
    if (outcome === "skipped") {
      result.skipped++;
      params.onSkipped?.("dispatch_skipped");
    } else {
      result[outcome]++;
    }
    if (outcome === "started" || outcome === "settled") {
      params.handledSessionKeys.add(params.resumeDedupeKey);
    } else if (outcome === "failed") {
      const current = await loadExpectedRestartRecoveryTarget({
        expected: {
          agentId: params.agentId,
          sessionId: params.entry.sessionId,
          sessionKey: params.sessionKey,
        },
        storePath: params.storePath,
      });
      if (
        getMainSessionRecoveryRetryCount(current?.mainRestartRecovery) === MAX_RECOVERY_RETRIES &&
        !current?.mainRestartRecovery?.reservation
      ) {
        params.onExhaustedTarget?.({
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          canonicalSessionKey: params.canonicalSessionKey,
          sessionId: params.entry.sessionId,
        });
      }
    }
  } catch (error) {
    if (params.shouldContinue?.() === false) {
      throw error;
    }
    mainSessionRecoveryLog.warn(
      `failed to dispatch restart recovery for ${params.sessionKey}: ${String(error)}`,
    );
    result.failed++;
  } finally {
    params.onDecision(decision);
  }
  return result;
}
