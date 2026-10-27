import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import {
  GatewayOperatorRecoveryAuthorizationError,
  GatewayOperatorRecoveryOwnershipError,
} from "../../infra/restart-recovery-errors.js";
import { captureSessionControllerSourceStopAcknowledgment } from "../../sessions/session-controller.mailbox-source.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryReservation } from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import type { RestartRecoveryTerminalStatus } from "./main-session-restart-dispatch-start.js";
import type { ResumeMainSessionParams } from "./main-session-restart-dispatch.types.js";
import {
  finishDelegatedRestartRecovery,
  settleTerminalPendingFinalRecovery,
} from "./main-session-restart-recovery-failure.js";

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

/** Join an accepted pre-start cancellation before restoring its durable recovery claim. */
export async function reconcileAcceptedRestartRecoveryCancellation(params: {
  controllerInput?: SessionControllerInput;
  dispatchAccepted: boolean;
  executionStarted: boolean;
  preStartAbortAttempted: boolean;
  preStartAbortConfirmed: boolean;
  repairAcceptedRecovery: () => Promise<void>;
  shouldContinue?: () => boolean;
}): Promise<boolean> {
  const current = () => params.shouldContinue?.() !== false;
  const unconfirmedStartTimeout =
    params.dispatchAccepted &&
    !params.executionStarted &&
    params.preStartAbortAttempted &&
    !params.preStartAbortConfirmed &&
    current();
  if (
    params.dispatchAccepted &&
    !params.executionStarted &&
    params.controllerInput?.custody.rpcAdopted === true &&
    params.controllerInput.abortSignal.aborted &&
    current()
  ) {
    // Stop owns this exact terminal publication; raw source work retains its own fence.
    await captureSessionControllerSourceStopAcknowledgment(params.controllerInput);
  }
  if (
    params.dispatchAccepted &&
    !params.executionStarted &&
    (!params.preStartAbortAttempted || params.preStartAbortConfirmed) &&
    current()
  ) {
    await params.repairAcceptedRecovery();
  }
  return unconfirmedStartTimeout;
}

/** A definitive pre-admission denial settles locally without dropping other recovery custody. */
export async function settleRejectedRestartRecovery(
  params: Pick<
    ResumeMainSessionParams,
    "agentId" | "sessionKey" | "storePath" | "cfg" | "gatewayRuntime" | "shouldContinue"
  > & {
    error: unknown;
    dispatchAccepted: boolean;
    rollback: Awaited<ReturnType<typeof rollbackRestartRecoveryReservation>> | undefined;
  },
): Promise<"settled" | "skipped" | "failed" | undefined> {
  const { error, rollback } = params;
  const entry = rollback?.entry;
  if (
    (!(error instanceof GatewayOperatorRecoveryAuthorizationError) &&
      !(error instanceof GatewayOperatorRecoveryOwnershipError)) ||
    params.dispatchAccepted ||
    rollback?.transition.kind !== "applied" ||
    !entry?.mainRestartRecovery
  ) {
    return undefined;
  }
  const result = await finishDelegatedRestartRecovery({
    ...params,
    entry,
    observation: {
      sessionId: entry.sessionId,
      cycleId: entry.mainRestartRecovery.cycleId,
      revision: entry.mainRestartRecovery.revision,
    },
    assertCurrent: () => {
      if (params.shouldContinue?.() === false) {
        throw new Error("Restart recovery admission is no longer current.", { cause: error });
      }
    },
    reason: error.message,
  });
  return result === "settled" || result === "tombstoned"
    ? "settled"
    : result === "skipped"
      ? "skipped"
      : "failed";
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
  pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
  sessionKey: string;
  sessionKeys: readonly string[];
  shouldContinue?: () => boolean;
  storePath: string;
  terminalStatus?: RestartRecoveryTerminalStatus;
}): Promise<void> {
  if (
    params.terminalStatus &&
    params.terminalStatus !== "ok" &&
    (await settleTerminalPendingFinalRecovery({
      ...params,
      runId: params.expectedRecoveryRunId,
      pendingFinalDelivery: params.pendingFinalDelivery,
      status:
        params.terminalStatus === "cancelled"
          ? "killed"
          : params.terminalStatus === "timeout"
            ? "timeout"
            : "failed",
      assertCurrent: () => {
        if (params.shouldContinue?.() === false) {
          throw new Error("Restart recovery settlement is no longer current.");
        }
      },
    }))
  ) {
    return;
  }
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
