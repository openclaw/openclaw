import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import type { RestartRecoveryTerminalStatus } from "./main-session-restart-dispatch-start.js";

export async function rollbackRestartRecoveryReservation(
  params: MainSessionRecoveryStoreTarget & {
    kind: "abandon_reservation" | "cancel_reservation";
    reservation: MainSessionRecoveryReservation;
  },
) {
  return await commitMainSessionRecovery({
    command: { kind: params.kind, reservation: params.reservation },
    requireWriteSuccess: true,
    target: params,
  });
}

// The run's own post-run cleanup can release its claim before this settlement. A run
// that never started then leaves its admitted lifecycle identity without a status.
function isReleasedRecoveryRun(entry: SessionEntry, runId: string): boolean {
  return (
    entry.status === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined &&
    entry.lifecycleRunId === runId &&
    hasRestartRecoveryTerminalRun(entry, runId)
  );
}

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
            ((normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ===
              params.expectedRecoveryRunId &&
              normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
                params.expectedRecoverySourceRunId) ||
              (params.terminalStatus !== undefined &&
                isReleasedRecoveryRun(entry, params.expectedRecoveryRunId))),
        )
        .toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
      if (!current) {
        return { result: undefined };
      }
      const entry = current.entry;
      const now = Date.now();
      if (params.terminalStatus) {
        entry.status =
          params.terminalStatus === "ok"
            ? "done"
            : params.terminalStatus === "timeout"
              ? "timeout"
              : params.terminalStatus === "cancelled"
                ? "killed"
                : "failed";
        entry.endedAt = now;
        const startedAt = asFiniteNumber(entry.startedAt);
        if (startedAt !== undefined) {
          entry.runtimeMs = Math.max(0, now - startedAt);
        }
        Object.assign(
          entry,
          buildMainSessionRecoverySettlementPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: params.expectedRecoveryRunId,
            terminalSourceRunId: params.expectedRecoverySourceRunId,
          }),
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
    ((params.terminalStatus !== undefined && isReleasedRecoveryRun(entry, params.recoveryRunId)) ||
      (entry.abortedLastRun === false &&
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === params.recoveryRunId &&
        entry.restartRecoveryRuns?.some(
          (run) =>
            run.runId === params.recoveryRunId &&
            run.lifecycleGeneration === params.lifecycleGeneration,
        ) === true) ||
      (hasRestartRecoveryTerminalRun(entry, params.recoveryRunId) &&
        ((params.terminalStatus === "ok" && entry.status === "done") ||
          (params.terminalStatus === "error" && entry.status === "failed") ||
          (params.terminalStatus === "cancelled" && entry.status === "killed") ||
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
