import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
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
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { matchesSubagentKillIntent } from "./subagent-control-kill-intent.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import * as runtime from "./subagent-control.runtime.js";
import type {
  SubagentCancellationControl,
  SubagentKillTargetState,
} from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { resolveSubagentKillTargetState } from "./subagent-registry-completion.js";
import type { captureSubagentExecution } from "./subagent-registry-execution-cleanup.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
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

function killFailure(error: unknown, prefix = "", format = formatErrorMessage) {
  if (hasSqliteWorkerOutcomeUnknown(error)) {
    throw error;
  }
  return { killed: false, error: `${prefix}${format(error)}` };
}

export async function mutateSubagentRunForKill(
  params: {
    entry: SubagentRunRecord;
    session: SubagentKillSession;
    stateContext: OpenClawStateWorkerContext;
    cancellationControl: SubagentCancellationControl;
    suppressTaskDelivery?: boolean;
    beforeSessionKill?: () => boolean;
    isCurrent: (entry: SubagentRunRecord, requirePreparedSession?: boolean) => boolean;
    withdrawQueuedReservation: () => void;
    refreshDescendants: () => Promise<number>;
  },
  captureExecution: () => ReturnType<typeof captureSubagentExecution>,
  stopAcceptance: { accepted: boolean },
): Promise<{
  killed: boolean;
  superseded?: boolean;
  declined?: true;
  targetState?: SubagentKillTargetState;
  error?: string;
  completedCleanupError?: string;
}> {
  const { stateContext } = params;
  const currentEntry = () => getCurrentSubagentRunOwner(subagentRuns, params.entry);
  const assertKnownOutcome = () => {
    const current = currentEntry();
    assertSubagentRegistryWriteOutcomeKnown(
      [current?.runId ?? params.entry.runId],
      stateContext.admission,
    );
  };
  const assertState = () => {
    stateContext.admission.assertCurrent();
    assertKnownOutcome();
    params.session.assertCurrent();
  };
  assertState();
  const targetState = () => {
    const current = currentEntry();
    return current ? resolveSubagentKillTargetState(current) : undefined;
  };
  const isCurrent = (requirePreparedSession = true) => {
    const current = currentEntry();
    return current !== undefined && params.isCurrent(current, requirePreparedSession);
  };
  const assertSelectedNativeRun = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    assertKnownOutcome();
    if (!isCurrent(false)) {
      throw new Error("Subagent kill settlement lost its original run");
    }
  };
  const assertSelectedRun = () => {
    assertSelectedNativeRun();
    params.session.assertCurrent();
  };
  const markKilledBestEffort = async () => {
    const selected = currentEntry();
    if (!selected) {
      return 0;
    }
    const { runId } = selected;
    try {
      return await markSubagentRunTerminated({
        runId,
        session: params.session,
        withdrawQueuedReservation: params.withdrawQueuedReservation,
        reason: "killed",
        suppressTaskDelivery: params.suppressTaskDelivery,
        context: stateContext,
        assertCurrent: assertSelectedRun,
      });
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      // A persistence failure must not leave the other siblings running.
      logVerbose(
        `subagents control kill: failed to persist ${runId}: ${formatErrorMessage(error)}`,
      );
      return 0;
    }
  };
  const initial = currentEntry();
  if (!initial || !isCurrent()) {
    return { killed: false, superseded: true };
  }
  if (resolveSubagentKillTargetState(initial)) {
    if (params.suppressTaskDelivery && initial.requesterSettleWake) {
      await cancelSubagentRequesterSettleWake(initial, () => {
        params.cancellationControl.assertCurrent();
        if (!isCurrent()) {
          throw new Error("Subagent ownership changed during cancellation; retry.");
        }
      });
    }
    if (
      currentEntry()?.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      currentEntry()?.suppressAnnounceReason !== "steer-restart"
    ) {
      await markKilledBestEffort();
    }
    if (!isCurrent()) {
      return { killed: false, superseded: true };
    }
    return { killed: false, targetState: targetState() };
  }
  if (initial.execution.endedAt && initial.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = params.session;
  const sessionId = resolved.entry?.sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  let admission: "ready" | "declined" | "busy" = "ready";
  let killClaim: Awaited<ReturnType<typeof claimSubagentRunKill>>;
  const claimSelectedRunKill = async () => {
    try {
      let selected = currentEntry();
      for (let attempt = 0; selected && attempt < 2; attempt++) {
        const claim = await claimSubagentRunKill({
          runId: selected.runId,
          expected: params.entry,
          sessionId,
          sessionLifecycleRevision,
          suppressTaskDelivery: params.suppressTaskDelivery,
          context: stateContext,
          assertCurrent: () => {
            assertState();
            params.cancellationControl.assertCurrent();
          },
        });
        if (claim) {
          return { claim };
        }
        const accepted = currentEntry();
        if (!accepted || accepted.runId === selected.runId) {
          return { claim: undefined };
        }
        // Only the same owner's acknowledged queued-to-running rekey can reselect admission.
        selected = accepted;
      }
      return { claim: undefined };
    } catch (error) {
      return {
        failure: killFailure(error, "Failed to persist subagent kill intent: ", (error) =>
          formatErrorMessage(error instanceof SubagentRegistryWriteError ? error.cause : error),
        ),
      };
    }
  };
  let preparationResult: Awaited<ReturnType<typeof mutateSubagentRunForKill>> | undefined;
  const releaseKillClaim = (claim: NonNullable<typeof killClaim>) => {
    const selected = currentEntry();
    return selected
      ? releaseSubagentRunKillClaim({
          runId: selected.runId,
          expected: params.entry,
          claim,
          context: stateContext,
        })
      : Promise.resolve(false);
  };
  const stillActive = async () => {
    try {
      if (killClaim && !stopAcceptance.accepted) {
        await releaseKillClaim(killClaim);
      }
    } catch (error) {
      return killFailure(
        error,
        "Subagent remained active and its kill intent could not be released: ",
      );
    }
    return {
      killed: false,
      error: stopAcceptance.accepted
        ? "Subagent accepted cancellation but is still active; cleanup is pending."
        : "Subagent is still active; try the kill again in a moment.",
    };
  };
  const cancellationFailure = async (
    error: unknown,
    declined?: true,
  ): Promise<NonNullable<typeof preparationResult>> => {
    let reason = formatErrorMessage(error);
    if (killClaim && !stopAcceptance.accepted) {
      try {
        await releaseKillClaim(killClaim);
      } catch (releaseError) {
        if (hasSqliteWorkerOutcomeUnknown(releaseError)) {
          throw releaseError;
        }
        reason += ` Kill intent could not be released: ${formatErrorMessage(releaseError)}`;
      }
    }
    return { killed: false, ...(declined ? { declined } : {}), error: reason };
  };
  const declineRevokedCancellation = ():
    | Promise<NonNullable<typeof preparationResult>>
    | undefined => {
    try {
      params.cancellationControl.assertCurrent();
      return undefined;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return cancellationFailure(error, true);
    }
  };
  const isKilledTarget = (target: SubagentKillTargetState) =>
    target.state === "terminal" && target.task.status === "cancelled";
  const killOwnerCurrent = () => {
    const current = currentEntry();
    return (
      current !== undefined &&
      isCurrent() &&
      (!killClaim ||
        ((matchesSubagentKillIntent(current.killIntent, killClaim) ||
          (!current.killIntent &&
            current.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            current.killReconciliation?.killedAt === killClaim.requestedAt &&
            current.killReconciliation.taskCancellationAccepted === true &&
            current.execution.lifecycleGeneration === killClaim.lifecycleGeneration)) &&
          (killClaim.lifecycleGeneration === undefined ||
            isAgentEventLifecycleGenerationCurrent(killClaim.lifecycleGeneration))))
    );
  };
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
      return killFailure(
        error,
        "Subagent session changed and its kill intent could not be released: ",
      );
    }
    return {
      killed: false,
      error: "Subagent session changed while the kill was pending; retry.",
    };
  };
  return await runExclusiveSessionLifecycleMutation("subagent-kill", {
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: async () => {
      for (
        let pending = params.cancellationControl.prepareRead?.();
        pending;
        pending = params.cancellationControl.prepareRead?.()
      ) {
        await pending;
      }
      if (!isCurrent()) {
        return;
      }
      let declined = declineRevokedCancellation();
      if (declined) {
        preparationResult = await declined;
        return;
      }
      // Admissions can release scheduler capacity synchronously when interrupted.
      await params.refreshDescendants();
      assertState();
      // The session fence is active before resolving/signaling other owners.
      // A refused full-session Stop must not interrupt their admissions or this collector.
      const execution = captureExecution()?.execution;
      const alreadyAborted = execution?.controller.signal.aborted;
      try {
        if (params.beforeSessionKill?.() === false) {
          admission = "declined";
          return;
        }
      } finally {
        // A caller hook can accept this exact abort before refusing or throwing.
        stopAcceptance.accepted ||=
          !alreadyAborted && execution?.controller.signal.aborted === true;
      }
      if (!isCurrent()) {
        return;
      }
      declined = declineRevokedCancellation();
      if (declined) {
        preparationResult = await declined;
        return;
      }
      const beforeInterruption = currentEntry();
      if (!beforeInterruption) {
        return;
      }
      if (
        beforeInterruption.swarmLaunchPending !== true &&
        beforeInterruption.execution.restartRecovery === undefined &&
        !resolveSubagentKillTargetState(beforeInterruption)
      ) {
        // Active completion must see cancellation before admission interruption.
        // Pending launch/recovery owners first need the drain to commit their identity.
        const claimed = await claimSelectedRunKill();
        if (claimed.failure) {
          preparationResult = claimed.failure;
          return;
        }
        killClaim = claimed.claim;
        if (killClaim) {
          if (!ownsSessionIncarnation()) {
            preparationResult = await releaseChangedSessionKill(killClaim);
            return;
          }
          if (!killOwnerCurrent()) {
            preparationResult = { killed: false, superseded: true };
            return;
          }
        }
      }
      declined = declineRevokedCancellation();
      if (declined) {
        preparationResult = await declined;
        return;
      }
      assertState();
      if (!killOwnerCurrent()) {
        preparationResult = { killed: false, superseded: true };
        return;
      }
      captureExecution();
      const interruption = startSessionWorkAdmissionInterruption({
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        reason: createAgentRunDirectAbortError(),
      });
      const interruptedSelectedRun = () => {
        const selected = currentEntry();
        return (
          selected !== undefined &&
          killOwnerCurrent() &&
          (interruption.interruptedRunIds.has(params.entry.runId) ||
            interruption.interruptedRunIds.has(selected.runId))
        );
      };
      stopAcceptance.accepted ||= interruptedSelectedRun();
      const released = await waitForSessionWorkAdmissionRelease(
        interruption.released,
        SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      );
      admission = released ? "ready" : "busy";
      stopAcceptance.accepted ||= interruptedSelectedRun();
      // Native preaccept cancellation first returns its recorded abort outcome.
      // Claim before another worker read lets that response adopt the queued row.
      const afterInterruption = currentEntry();
      if (
        released &&
        params.beforeSessionKill &&
        afterInterruption?.swarmLaunchPending === true &&
        afterInterruption.execution.restartRecovery === undefined &&
        !resolveSubagentKillTargetState(afterInterruption) &&
        isCurrent()
      ) {
        const claimed = await claimSelectedRunKill();
        if (claimed.failure) {
          preparationResult = claimed.failure;
        } else {
          killClaim = claimed.claim;
        }
      }
    },
    run: async (): Promise<Awaited<ReturnType<typeof mutateSubagentRunForKill>>> => {
      if (preparationResult) {
        return preparationResult;
      }
      if (admission === "declined") {
        return { killed: false, declined: true as const };
      }
      if (admission === "busy") {
        return stillActive();
      }
      let readFailure: { error: unknown } | undefined;
      try {
        for (
          let pending = params.cancellationControl.prepareRead?.();
          pending;
          pending = params.cancellationControl.prepareRead?.()
        ) {
          await pending;
        }
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        if (!stopAcceptance.accepted) {
          return cancellationFailure(error);
        }
        readFailure = { error };
      }
      // Admission draining yields. Fence the exact row before
      // touching session-owned queues so a successor cannot inherit an older kill.
      if (!isCurrent()) {
        return { killed: false, superseded: true };
      }
      if (killClaim && !ownsSessionIncarnation()) {
        return releaseChangedSessionKill(killClaim);
      }
      if (!readFailure) {
        await params.refreshDescendants();
      }
      if (!isCurrent()) {
        return { killed: false, superseded: true };
      }
      const targetStateAfterAdmission = targetState();
      if (targetStateAfterAdmission) {
        const killedTarget = isKilledTarget(targetStateAfterAdmission);
        const claimedCurrentKill = killClaim !== undefined && killOwnerCurrent();
        if (killedTarget && (!killClaim || claimedCurrentKill)) {
          await markKilledBestEffort();
        }
        return {
          killed: killedTarget && claimedCurrentKill,
          targetState: targetStateAfterAdmission,
          ...(readFailure ? { error: formatErrorMessage(readFailure.error) } : {}),
        };
      }
      const declined = readFailure ? undefined : declineRevokedCancellation();
      if (declined && !stopAcceptance.accepted) {
        return declined;
      }
      if (!killClaim) {
        const claimed = await claimSelectedRunKill();
        if (claimed.failure) {
          return claimed.failure;
        }
        killClaim = claimed.claim;
      }
      if (!killClaim) {
        return {
          killed: false,
          superseded: true,
        };
      }
      const claimedKill = killClaim;
      const settleTargetCancellation = async () => {
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        if (!killOwnerCurrent()) {
          return { killed: false, superseded: true };
        }
        const selected = currentEntry();
        if (!selected) {
          return { killed: false, superseded: true };
        }
        let marked = 0;
        try {
          marked = await markSubagentRunTerminated({
            runId: selected.runId,
            session: params.session,
            withdrawQueuedReservation: params.withdrawQueuedReservation,
            reason: "killed",
            suppressTaskDelivery: params.suppressTaskDelivery,
            context: stateContext,
            assertCurrent: () => {
              assertState();
              if (!stopAcceptance.accepted) {
                params.cancellationControl.assertCurrent();
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
            onPublished: (count) => {
              marked = count;
            },
          });
        } catch (error) {
          const action =
            marked > 0 ? "finish subagent kill cleanup" : "persist subagent kill tombstone";
          return {
            ...killFailure(error, `Failed to ${action}: `),
            killed: marked > 0,
          };
        }
        if (marked === 0) {
          assertState();
          if (!isCurrent()) {
            return { killed: false, superseded: true };
          }
          return {
            killed: false,
            targetState: targetState(),
          };
        }
        return { killed: marked > 0 };
      };
      try {
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        if (!killOwnerCurrent()) {
          return { killed: false, superseded: true };
        }
        if (readFailure || declined) {
          // Missing caller facts or revocation fence new effects, but the accepted
          // interruption's exact claim still owns settlement.
          const settled: Awaited<ReturnType<typeof mutateSubagentRunForKill>> =
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
          return stopAcceptance.accepted ? await settleTargetCancellation() : declinedBeforeAbort;
        }
        if (!killOwnerCurrent()) {
          return { killed: false, superseded: true };
        }
        const aborted = sessionId ? runtime.abortEmbeddedAgentRun(sessionId) : false;
        stopAcceptance.accepted ||= aborted;
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill(claimedKill);
        }
        const declinedBeforeQueueClear = declineRevokedCancellation();
        if (declinedBeforeQueueClear) {
          return stopAcceptance.accepted
            ? await settleTargetCancellation()
            : declinedBeforeQueueClear;
        }
        if (!killOwnerCurrent()) {
          return { killed: false, superseded: true };
        }
        const cleared = runtime.clearSessionLifecycleQueues({
          keys: [childSessionKey, sessionId],
          agentId: resolved.agentId,
          sessionKey: childSessionKey,
          sessionId,
          assertCurrent: () => {
            assertState();
            params.cancellationControl.assertCurrent();
            if (!killOwnerCurrent()) {
              throw new Error("Subagent queue cleanup lost its original kill claim.");
            }
          },
        });
        if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
          logVerbose(
            `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
          );
        }
        if (active && !stopAcceptance.accepted) {
          return stillActive();
        }
        const settledTarget = targetState();
        if (settledTarget) {
          const killedTarget = isKilledTarget(settledTarget);
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
                targetState: settledTarget,
                error: `Completed subagent kill intent could not be released: ${formatErrorMessage(error)}`,
              };
            }
          }
          return { killed: killedTarget, targetState: settledTarget };
        }
        return await settleTargetCancellation();
      } catch (error) {
        return killFailure(error);
      }
    },
    finalize: async () => {
      // Preparation now owns the claim, including failed drains and persistence.
      // Only its exact retained claim may withdraw the captured reservation.
      if (killClaim && matchesSubagentKillIntent(currentEntry()?.killIntent, killClaim)) {
        params.withdrawQueuedReservation();
      }
    },
  });
}
