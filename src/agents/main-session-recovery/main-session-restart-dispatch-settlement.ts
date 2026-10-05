import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import {
  retryMainSessionRecoveryMutation,
  scheduleMainSessionRecoveryMutation,
} from "./main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "./main-session-recovery-owner-release.js";
import { isMainSessionRecoveryPending } from "./main-session-recovery-state.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import type { RestartRecoveryTerminalStatus } from "./main-session-restart-dispatch-start.js";
import { mainSessionRecoveryLog as log } from "./main-session-restart-recovery-shared.js";

async function settleRestartRecoveryDispatch(params: {
  agentId?: string;
  expectedRecoveryRunId: string;
  expectedRecoverySourceRunId?: string;
  expectedSessionId: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  assertCurrent?: () => void;
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  await applySessionEntryReplacements({
    agentId: params.agentId,
    sessionKeys: params.sessionKeys,
    storePath: params.storePath,
    assertCommitAllowed: params.assertCurrent,
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
        entry.status =
          params.terminalStatus === "ok"
            ? "done"
            : params.terminalStatus === "timeout"
              ? "timeout"
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
  recoverySourceRunId?: string;
  sessionId: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): boolean {
  const entry = params.admission.entry;
  return (
    entry?.sessionId === params.sessionId &&
    ((entry.abortedLastRun === false &&
      entry.restartRecoveryDeliveryRunId === params.recoveryRunId &&
      entry.restartRecoveryDeliverySourceRunId === params.recoverySourceRunId &&
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

/** One admitted startup write joins the native callback and its scheduler observation. */
export function createStartedRecoverySettlement(
  params: Parameters<typeof settleAcceptedRestartRecovery>[0],
) {
  let started: Promise<boolean> | undefined;
  const settleStarted = () => (started ??= settleAcceptedRestartRecovery(params));
  return {
    onStarted: async () => {
      if (!(await settleStarted())) {
        throw new Error(
          `restart recovery admission changed before execution: ${params.sessionKey}`,
        );
      }
    },
    settle: (terminalStatus?: RestartRecoveryTerminalStatus) =>
      terminalStatus
        ? settleAcceptedRestartRecovery({ ...params, terminalStatus })
        : settleStarted(),
  };
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
      deliveryClaim: {
        runId: params.expectedRecoveryRunId,
        sourceRunId: params.expectedRecoverySourceRunId,
      },
    },
    shouldContinue: params.shouldContinue,
    assertCommitAllowed: params.assertCurrent,
    target: params,
  });
  if (
    admission.transition.kind !== "admitted_recovery" &&
    !isExactRestartRecoveryDispatchAdmission({
      admission,
      lifecycleGeneration: params.lifecycleGeneration,
      recoveryRunId: params.expectedRecoveryRunId,
      recoverySourceRunId: params.expectedRecoverySourceRunId,
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

export async function rollbackRestartRecoveryReservation(
  params: MainSessionRecoveryStoreTarget & {
    kind: "abandon_reservation" | "cancel_reservation";
    reservation: MainSessionRecoveryReservation;
  },
) {
  return await retryMainSessionRecoveryMutation(async () =>
    commitMainSessionRecovery({
      command: { kind: params.kind, reservation: params.reservation },
      requireWriteSuccess: true,
      target: params,
    }),
  );
}

export function scheduleRestartRecoveryReservationRollback(
  params: Parameters<typeof rollbackRestartRecoveryReservation>[0],
): void {
  // Keep the exact reservation token alive after transient store outages.
  // A Gateway restart safely retires the timer and its stale-generation slot.
  scheduleMainSessionRecoveryMutation({
    mutation: () => rollbackRestartRecoveryReservation(params),
    onError: (error) => {
      log.warn(
        `failed delayed restart recovery reservation rollback ${params.sessionKey}: ${String(error)}`,
      );
    },
    onSuccess: ({ entry, sessionKey }) => {
      if (
        entry?.sessionId === params.reservation.sessionId &&
        sessionKey &&
        isMainSessionRecoveryPending(entry, sessionKey)
      ) {
        scheduleMainSessionRecoveryPendingTarget({
          agentId: params.agentId,
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
        });
      }
    },
  });
}
