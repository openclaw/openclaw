import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoveryTerminalRun,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import type { RestartRecoveryTerminalStatus } from "./main-session-restart-dispatch-start.js";
import { normalizeFiniteTimestamp } from "./main-session-restart-recovery-shared.js";

async function settleRestartRecoveryDispatch(params: {
  agentId?: string;
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    update: (entries) => {
      if (params.shouldContinue?.() === false) {
        return { result: undefined };
      }
      const current = entries
        .filter(
          ({ entry }) =>
            entry.sessionId === params.expectedSessionId &&
            normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ===
              params.expectedRecoveryRunId &&
            normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
              params.expectedRecoverySourceRunId,
        )
        .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
      if (!current) {
        return { result: undefined };
      }
      const entry = current.entry;
      const now = Date.now();
      if (params.terminalStatus) {
        entry.abortedLastRun = params.terminalStatus !== "ok";
        entry.status =
          params.terminalStatus === "ok"
            ? "done"
            : params.terminalStatus === "timeout"
              ? "timeout"
              : "failed";
        entry.endedAt = now;
        const startedAt = normalizeFiniteTimestamp(entry.startedAt);
        if (startedAt !== undefined) {
          entry.runtimeMs = Math.max(0, now - startedAt);
        }
        entry.restartRecoveryForceSafeTools = undefined;
        Object.assign(
          entry,
          buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: params.expectedRecoveryRunId,
            terminalSourceRunId: params.expectedRecoverySourceRunId,
          }),
          buildMainSessionRecoveryClearPatch(entry),
        );
      } else {
        entry.abortedLastRun = false;
      }
      entry.updatedAt = now;
      return {
        result: undefined,
        replacements: [{ sessionKey: current.sessionKey, entry }],
      };
    },
  });
}

function isExactRestartRecoveryDispatchAdmission(params: {
  admission: Awaited<ReturnType<typeof commitMainSessionRecovery>>;
  lifecycleGeneration: string;
  recoveryRunId: string;
  sessionId: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): boolean {
  const entry = params.admission.entry;
  return (
    entry?.sessionId === params.sessionId &&
    ((entry.abortedLastRun === false &&
      normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === params.recoveryRunId &&
      entry.restartRecoveryRuns?.some(
        (run) =>
          run.runId === params.recoveryRunId &&
          run.lifecycleGeneration === params.lifecycleGeneration,
      ) === true) ||
      (hasRestartRecoveryTerminalRun(entry, params.recoveryRunId) &&
        ((params.terminalStatus === "ok" && entry.status === "done") ||
          (params.terminalStatus === "error" && entry.status === "failed") ||
          (params.terminalStatus === "timeout" && entry.status === "timeout"))))
  );
}

export async function settleAcceptedRestartRecovery(
  params: Parameters<typeof settleRestartRecoveryDispatch>[0] & {
    lifecycleGeneration: string;
    reservation?: MainSessionRecoveryReservation;
    sessionKey: string;
  },
): Promise<boolean> {
  const admission = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: params.lifecycleGeneration,
      now: Date.now(),
      runId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
    },
    shouldContinue: params.shouldContinue,
    target: params,
  });
  if (
    admission.transition.kind !== "admitted_recovery" &&
    !isExactRestartRecoveryDispatchAdmission({
      admission,
      lifecycleGeneration: params.lifecycleGeneration,
      recoveryRunId: params.expectedRecoveryRunId,
      sessionId: params.expectedSessionId,
      terminalStatus: params.terminalStatus,
    })
  ) {
    return false;
  }
  if (params.shouldContinue?.() === false) {
    return true;
  }
  if (params.reservation) {
    await commitMainSessionRecovery({
      command: { kind: "abandon_reservation", reservation: params.reservation },
      target: params,
    });
  }
  if (params.shouldContinue?.() !== false) {
    await settleRestartRecoveryDispatch(params);
  }
  return true;
}
