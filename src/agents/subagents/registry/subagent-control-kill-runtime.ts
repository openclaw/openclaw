/** Session-lifecycle mutation and persistence for subagent kills. */

import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
  waitForSessionWorkAdmissionRelease,
} from "../../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { isCurrentSubagentRun } from "./subagent-control-scope.js";
import {
  persistSubagentAbortedLastRun,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type SubagentCancellationControl,
  type SubagentKillTargetState,
} from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  cancelSubagentRequesterSettleWake,
  claimSubagentRunKill,
  markSubagentRunTerminated,
  releaseSubagentRunKillClaim,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const subagentKillRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

function formatKillPersistenceError(error: unknown): string {
  return formatErrorMessage(error instanceof SubagentRegistryWriteError ? error.cause : error);
}

export function resolveSubagentKillTargetState(
  entry: SubagentRunRecord,
): SubagentKillTargetState | undefined {
  if (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason !== "steer-restart"
  ) {
    const taskEndedAt = resolveKilledSubagentTaskEndedAt(entry);
    return typeof taskEndedAt === "number"
      ? {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: taskEndedAt,
            error: SUBAGENT_KILL_TASK_ERROR,
          },
        }
      : undefined;
  }
  const terminal = resolveFinalizedSubagentTaskState(entry);
  if (terminal) {
    return { state: "terminal", task: terminal };
  }
  return typeof entry.execution.endedAt === "number" &&
    entry.pauseReason !== "sessions_yield" &&
    (entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      entry.suppressAnnounceReason === "steer-restart")
    ? { state: "finalizing" }
    : undefined;
}

async function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): Promise<number> {
  try {
    return await markSubagentRunTerminated(params);
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    // The registry transition rolled back atomically. Keep multi-run control
    // moving so one persistence failure cannot leave siblings running.
    logVerbose(
      `subagents control kill: failed to persist ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

export async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  session: SubagentKillSession;
  stateContext?: OpenClawStateWorkerContext;
  cancellationControl?: SubagentCancellationControl;
  suppressTaskDelivery?: boolean;
  beforeSessionKill?: () => boolean;
  isCurrent?: (entry: SubagentRunRecord, requirePreparedSession?: boolean) => boolean;
  withdrawQueuedReservation: () => void;
  refreshDescendants: () => Promise<number>;
}): Promise<{
  killed: boolean;
  sessionId?: string;
  superseded?: boolean;
  declined?: true;
  targetState?: SubagentKillTargetState;
  error?: string;
}> {
  const stateContext = params.stateContext ?? captureOpenClawStateWorkerContext();
  const assertState = () => {
    stateContext.admission.assertCurrent();
    assertSubagentRegistryWriteOutcomeKnown([params.entry.runId], stateContext.admission);
    params.session.assertCurrent();
  };
  assertState();
  const isCurrent = (requirePreparedSession = true) =>
    isCurrentSubagentRun(params.entry, params.cfg) &&
    params.isCurrent?.(params.entry, requirePreparedSession) !== false;
  const assertSelectedNativeRun = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    assertSubagentRegistryWriteOutcomeKnown([params.entry.runId], stateContext.admission);
    if (!isCurrent(false)) {
      throw new Error("Subagent kill settlement lost its original run");
    }
  };
  const assertSelectedRun = () => {
    assertSelectedNativeRun();
    params.session.assertCurrent();
  };
  const markKilledBestEffort = () =>
    markSubagentRunTerminatedBestEffort({
      runId: params.entry.runId,
      session: params.session,
      withdrawQueuedReservation: params.withdrawQueuedReservation,
      reason: "killed",
      suppressTaskDelivery: params.suppressTaskDelivery,
      context: stateContext,
      assertCurrent: assertSelectedRun,
    });
  const initialTargetState = resolveSubagentKillTargetState(params.entry);
  if (initialTargetState) {
    if (params.suppressTaskDelivery && params.entry.requesterSettleWake) {
      await cancelSubagentRequesterSettleWake(params.entry, () => {
        params.cancellationControl?.assertCurrent();
        if (!isCurrent()) {
          throw new Error("Subagent ownership changed during cancellation; retry.");
        }
      });
    }
    if (
      params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      params.entry.suppressAnnounceReason !== "steer-restart"
    ) {
      await markKilledBestEffort();
    }
    return { killed: false, targetState: initialTargetState };
  }
  if (params.entry.execution.endedAt && params.entry.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = params.session;
  const sessionId = resolved.entry?.sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  const runtime = await subagentKillRuntimeLoader.load();
  let admission: "ready" | "declined" | "busy" = "ready";
  let killClaim: Awaited<ReturnType<typeof claimSubagentRunKill>>;
  const claimSelectedRunKill = () =>
    claimSubagentRunKill({
      runId: params.entry.runId,
      expected: params.entry,
      sessionId,
      sessionLifecycleRevision,
      suppressTaskDelivery: params.suppressTaskDelivery,
      context: stateContext,
      assertCurrent: () => {
        assertState();
        params.cancellationControl?.assertCurrent();
      },
      assertPublicationCurrent: assertSelectedNativeRun,
    });
  let stopAccepted = false;
  let preparationResult: Awaited<ReturnType<typeof killSubagentRun>> | undefined;
  const releaseKillClaim = (claim: NonNullable<typeof killClaim>) =>
    releaseSubagentRunKillClaim({
      runId: params.entry.runId,
      expected: params.entry,
      claim,
      context: stateContext,
    });
  const cancellationFailure = async (
    error: unknown,
    declined?: true,
  ): Promise<NonNullable<typeof preparationResult>> => {
    let reason = formatErrorMessage(error);
    if (killClaim && !stopAccepted) {
      try {
        await releaseKillClaim(killClaim);
      } catch (releaseError) {
        if (hasSqliteWorkerOutcomeUnknown(releaseError)) {
          throw releaseError;
        }
        reason += ` Kill intent could not be released: ${formatErrorMessage(releaseError)}`;
      }
    }
    return { killed: false, sessionId, ...(declined ? { declined } : {}), error: reason };
  };
  const declineRevokedCancellation = ():
    | Promise<NonNullable<typeof preparationResult>>
    | undefined => {
    try {
      params.cancellationControl?.assertCurrent();
      return undefined;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return cancellationFailure(error, true);
    }
  };
  const killOwnerCurrent = () =>
    isCurrent() &&
    (!killClaim ||
      ((params.entry.killIntent === killClaim ||
        (params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          params.entry.killReconciliation !== undefined &&
          params.entry.execution.lifecycleGeneration === killClaim.lifecycleGeneration)) &&
        (killClaim.lifecycleGeneration === undefined ||
          isAgentEventLifecycleGenerationCurrent(killClaim.lifecycleGeneration))));
  const ownsSessionIncarnation = () => {
    try {
      assertState();
      return true;
    } catch (error) {
      if (isSessionDeliveryGenerationRevokedError(error)) {
        return false;
      }
      throw error;
    }
  };
  const releaseChangedSessionKill = async (claim: NonNullable<typeof killClaim>) => {
    try {
      await releaseKillClaim(claim);
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return {
        killed: false,
        sessionId,
        error: `Subagent session changed and its kill intent could not be released: ${formatErrorMessage(error)}`,
      };
    }
    return {
      killed: false,
      sessionId,
      error: "Subagent session changed while the kill was pending; retry.",
    };
  };
  return await runExclusiveSessionLifecycleMutation({
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: async () => {
      for (
        let pending = params.cancellationControl?.prepareRead?.();
        pending;
        pending = params.cancellationControl?.prepareRead?.()
      ) {
        await pending;
      }
      if (!isCurrent()) {
        return;
      }
      {
        const declined = declineRevokedCancellation();
        if (declined) {
          preparationResult = await declined;
          return;
        }
      }
      // Admissions can release scheduler capacity synchronously when interrupted.
      await params.refreshDescendants();
      assertState();
      // The session fence is active before resolving/signaling other owners.
      // A refused full-session Stop must not interrupt their admissions or this collector.
      if (params.beforeSessionKill?.() === false) {
        admission = "declined";
        return;
      }
      if (!isCurrent()) {
        return;
      }
      {
        const declined = declineRevokedCancellation();
        if (declined) {
          preparationResult = await declined;
          return;
        }
      }
      if (
        params.entry.swarmLaunchPending !== true &&
        params.entry.execution.restartRecovery === undefined &&
        !resolveSubagentKillTargetState(params.entry)
      ) {
        try {
          // Active completion must see cancellation before admission interruption.
          // Pending launch/recovery owners first need the drain to commit their identity.
          killClaim = await claimSelectedRunKill();
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          preparationResult = {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill intent: ${formatKillPersistenceError(error)}`,
          };
          return;
        }
        if (killClaim) {
          if (!ownsSessionIncarnation()) {
            preparationResult = await releaseChangedSessionKill(killClaim);
            return;
          }
          if (!killOwnerCurrent()) {
            preparationResult = { killed: false, sessionId, superseded: true };
            return;
          }
        }
      }
      {
        const declined = declineRevokedCancellation();
        if (declined) {
          preparationResult = await declined;
          return;
        }
      }
      assertState();
      const interruption = startSessionWorkAdmissionInterruption({
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        reason: createAgentRunDirectAbortError(),
      });
      stopAccepted = interruption.interruptedRunIds.has(params.entry.runId) && killOwnerCurrent();
      const released = await waitForSessionWorkAdmissionRelease(
        interruption.released,
        SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      );
      admission = released ? "ready" : "busy";
      // Native preaccept cancellation first returns its recorded abort outcome.
      // Claim before another worker read lets that response adopt the queued row.
      if (
        released &&
        params.beforeSessionKill &&
        params.entry.swarmLaunchPending === true &&
        params.entry.execution.restartRecovery === undefined &&
        !resolveSubagentKillTargetState(params.entry) &&
        isCurrent()
      ) {
        try {
          killClaim = await claimSelectedRunKill();
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          preparationResult = {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill intent: ${formatKillPersistenceError(error)}`,
          };
        }
      }
    },
    run: async () => {
      if (preparationResult) {
        return preparationResult;
      }
      if (admission === "declined") {
        return { killed: false, sessionId, declined: true as const };
      }
      if (admission === "busy") {
        try {
          if (killClaim && !stopAccepted) {
            await releaseKillClaim(killClaim);
          }
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          return {
            killed: false,
            sessionId,
            error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: stopAccepted
            ? "Subagent accepted cancellation but is still active; cleanup is pending."
            : "Subagent is still active; try the kill again in a moment.",
        };
      }
      let readFailure: { error: unknown } | undefined;
      try {
        for (
          let pending = params.cancellationControl?.prepareRead?.();
          pending;
          pending = params.cancellationControl?.prepareRead?.()
        ) {
          await pending;
        }
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        if (!stopAccepted) {
          return cancellationFailure(error);
        }
        readFailure = { error };
      }
      // Runtime loading and admission draining yield. Fence the exact row before
      // touching session-owned queues so a successor cannot inherit an older kill.
      if (!isCurrent()) {
        return { killed: false, sessionId, superseded: true };
      }
      if (killClaim && !ownsSessionIncarnation()) {
        return releaseChangedSessionKill(killClaim);
      }
      if (!readFailure) {
        await params.refreshDescendants();
      }
      const targetStateAfterRuntimeLoad = resolveSubagentKillTargetState(params.entry);
      if (targetStateAfterRuntimeLoad) {
        const killedTarget =
          params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          params.entry.suppressAnnounceReason !== "steer-restart";
        const claimedCurrentKill = killClaim !== undefined && killOwnerCurrent();
        if (killedTarget && (!killClaim || claimedCurrentKill)) {
          await markKilledBestEffort();
        }
        return {
          killed: killedTarget && claimedCurrentKill,
          sessionId,
          targetState: targetStateAfterRuntimeLoad,
          ...(readFailure ? { error: formatErrorMessage(readFailure.error) } : {}),
        };
      }
      const declined = readFailure ? undefined : declineRevokedCancellation();
      if (declined && !stopAccepted) {
        return declined;
      }
      const persistAbortedLastRun = (abortedLastRun: boolean, strict = false) =>
        persistSubagentAbortedLastRun({
          childSessionKey,
          storePath: resolved.storePath,
          hasSessionEntry: resolved.entry !== undefined,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: sessionLifecycleRevision,
          abortedLastRun,
          isCurrent: () => killOwnerCurrent(),
          assertCommitAllowed: () => {
            assertState();
            if (!killOwnerCurrent()) {
              throw new Error("subagent kill lifecycle retired before abort-marker commit");
            }
          },
          strict,
        });
      if (!killClaim) {
        try {
          killClaim = await claimSelectedRunKill();
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          return {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill intent: ${formatKillPersistenceError(error)}`,
          };
        }
      }
      if (!killClaim) {
        return {
          killed: false,
          sessionId,
          superseded: true,
        };
      }
      const claimedKill = killClaim;
      const settleTargetCancellation = async () => {
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        if (!killOwnerCurrent()) {
          return { killed: false, sessionId, superseded: true };
        }
        let marked: number;
        try {
          marked = await markSubagentRunTerminated({
            runId: params.entry.runId,
            session: params.session,
            withdrawQueuedReservation: params.withdrawQueuedReservation,
            reason: "killed",
            suppressTaskDelivery: params.suppressTaskDelivery,
            context: stateContext,
            assertCurrent: () => {
              assertState();
              if (!stopAccepted) {
                params.cancellationControl?.assertCurrent();
              }
              if (!killOwnerCurrent()) {
                throw new Error("Subagent kill settlement lost its original claim.");
              }
            },
            assertPublicationCurrent: () => {
              assertState();
              if (!killOwnerCurrent()) {
                throw new Error("Subagent kill publication lost its original claim");
              }
            },
          });
        } catch (error) {
          if (hasSqliteWorkerOutcomeUnknown(error)) {
            throw error;
          }
          return {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill tombstone: ${formatErrorMessage(error)}`,
          };
        }
        if (marked === 0) {
          assertState();
          if (!isCurrent()) {
            return { killed: false, sessionId, superseded: true };
          }
          return {
            killed: false,
            sessionId,
            targetState: resolveSubagentKillTargetState(params.entry),
          };
        }
        await persistAbortedLastRun(true);
        return { killed: marked > 0, sessionId };
      };
      try {
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        if (!killOwnerCurrent()) {
          return { killed: false, sessionId, superseded: true };
        }
        if (readFailure || declined) {
          // Missing caller facts or revocation fence new effects, but the accepted
          // interruption's exact claim still owns settlement.
          const settled: Awaited<ReturnType<typeof killSubagentRun>> =
            await settleTargetCancellation();
          return readFailure
            ? {
                ...settled,
                error: [settled.error, formatErrorMessage(readFailure.error)]
                  .filter(Boolean)
                  .join(" "),
              }
            : settled;
        }
        const active = sessionId ? runtime.isEmbeddedAgentRunActive(sessionId) : false;
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        const declinedBeforeAbort = declineRevokedCancellation();
        if (declinedBeforeAbort) {
          return stopAccepted ? await settleTargetCancellation() : declinedBeforeAbort;
        }
        const aborted = sessionId ? runtime.abortEmbeddedAgentRun(sessionId) : false;
        stopAccepted ||= aborted;
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        const declinedBeforeQueueClear = declineRevokedCancellation();
        if (declinedBeforeQueueClear) {
          return stopAccepted ? await settleTargetCancellation() : declinedBeforeQueueClear;
        }
        const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
        if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
          logVerbose(
            `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
          );
        }
        if (active && !stopAccepted) {
          try {
            await releaseKillClaim(killClaim);
          } catch (error) {
            if (hasSqliteWorkerOutcomeUnknown(error)) {
              throw error;
            }
            return {
              killed: false,
              sessionId,
              error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
            };
          }
          return {
            killed: false,
            sessionId,
            error: "Subagent is still active; try the kill again in a moment.",
          };
        }
        const targetState = resolveSubagentKillTargetState(params.entry);
        if (targetState) {
          const killedTarget =
            targetState.state === "terminal" &&
            targetState.task.status === "cancelled" &&
            targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
          if (killedTarget) {
            await markKilledBestEffort();
          } else {
            try {
              await releaseKillClaim(killClaim);
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              return {
                killed: false,
                sessionId,
                targetState,
                error: `Completed subagent kill intent could not be released: ${formatErrorMessage(error)}`,
              };
            }
          }
          return { killed: killedTarget, sessionId, targetState };
        }
        return await settleTargetCancellation();
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        return { killed: false, sessionId, error: formatErrorMessage(error) };
      }
    },
    finalize: async () => {
      // Preparation now owns the claim, including failed drains and persistence.
      // Only its exact retained claim may withdraw the captured reservation.
      if (
        killClaim &&
        subagentRuns.get(params.entry.runId) === params.entry &&
        params.entry.killIntent === killClaim
      ) {
        params.withdrawQueuedReservation();
      }
    },
  });
}
