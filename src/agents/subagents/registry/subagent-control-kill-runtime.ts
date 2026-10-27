import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  runSessionMutation,
  captureSessionTarget,
  startSessionControllerInterruption,
} from "../../../sessions/session-controller.lifecycle.js";
import { isCurrentSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../../sessions/session-controller.stop.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { captureSubagentCommands } from "./subagent-control-commands.js";
import { createSubagentKillAcceptance } from "./subagent-control-kill-acceptance.js";
import { captureSubagentKillSources } from "./subagent-control-kill-capture.js";
import {
  createSubagentKillSettlementOwner,
  isKilledSubagentTarget,
  markSubagentRunTerminatedBestEffort,
} from "./subagent-control-kill-settlement.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import type {
  SubagentCancellationControl,
  SubagentKillInputSnapshot,
  SubagentRunKillResult,
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
  claimSubagentRunKill,
  releaseSubagentRunKillClaim,
  retireSubagentObligations,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const subagentKillRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

export async function mutateSubagentRunForKill(
  params: {
    entry: SubagentRunRecord;
    session: SubagentKillSession;
    stateContext: OpenClawStateWorkerContext;
    cancellationControl: SubagentCancellationControl;
    /** A requester-wide Stop or reset, or a cascade below a cancelled root: nothing is owed. */
    suppressTaskDelivery?: boolean;
    exactRunSelection?: boolean;
    commands?: ReturnType<typeof captureSubagentCommands>;
    beforeSessionKill?: () => boolean | Promise<boolean>;
    requiredSessionId?: string;
    isCurrent: (entry: SubagentRunRecord, requirePreparedSession?: boolean) => boolean;
    withdrawQueuedReservation: () => void;
    refreshDescendants: () => Promise<number>;
  },
  captureExecution: () => ReturnType<typeof captureSubagentExecution>,
  stopAcceptance: { accepted: boolean; queuedOnly?: boolean },
  captureCleanup: (capture: ReturnType<typeof captureSessionControllerStop>) => void,
): Promise<SubagentRunKillResult> {
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
  const markKilledBestEffort = () => {
    const selected = currentEntry();
    return selected
      ? markSubagentRunTerminatedBestEffort({
          runId: selected.runId,
          session: params.session,
          withdrawQueuedReservation: params.withdrawQueuedReservation,
          reason: "killed",
          suppressTaskDelivery: params.suppressTaskDelivery,
          suppressSessionEffects: stopAcceptance.queuedOnly,
          context: stateContext,
          assertCurrent: assertSelectedRun,
        })
      : Promise.resolve(0);
  };
  const initial = currentEntry();
  if (!initial || !isCurrent()) {
    return { killed: false, superseded: true };
  }
  if (resolveSubagentKillTargetState(initial)) {
    let continuationRetired = false;
    if (params.suppressTaskDelivery) {
      await retireSubagentObligations(
        initial,
        () => {
          params.cancellationControl.assertCurrent();
          if (!isCurrent()) {
            throw new Error("Subagent ownership changed during cancellation; retry.");
          }
        },
        { requesterNotified: params.suppressTaskDelivery },
      );
      continuationRetired =
        initial.requesterSettleWake !== undefined &&
        initial.execution.status === "terminal" &&
        initial.pauseReason !== "sessions_yield";
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
    return {
      killed: false,
      targetState: targetState(),
      ...(continuationRetired ? { continuationRetired: true as const } : {}),
    };
  }
  if (initial.execution.endedAt && initial.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const gatewaySourceSelection =
    params.requiredSessionId !== undefined && params.beforeSessionKill !== undefined;
  const resolved = params.session;
  const legacy = resolveSubagentChildAuthority(initial).status === "legacy-unverified";
  const exactRun = legacy || params.exactRunSelection === true;
  const commands = params.commands ?? captureSubagentCommands(initial, resolved);
  const sessionId = resolved.entry?.sessionId;
  const captureSessionId = params.requiredSessionId ?? sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  const target = captureSessionTarget({
    storeScope: resolved.storePath,
    sessionKey: childSessionKey,
    agentId: resolved.agentId,
    incarnation: sessionId,
  });
  let capturedStop: ReturnType<typeof captureSessionControllerStop> | undefined;
  const capturedRuntimeRefused = () =>
    capturedStop !== undefined &&
    [
      ...capturedStop.operations,
      ...capturedStop.activeInputs.flatMap((input) => input.claim?.operation ?? []),
    ].some(
      (operation) =>
        isCurrentSessionControllerOperation(operation) &&
        !operation.result &&
        !operation.abortSignal.aborted,
    );
  let capturedQueued: SubagentKillInputSnapshot[] = [];
  let runtime: Awaited<ReturnType<typeof subagentKillRuntimeLoader.load>> | undefined;
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
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return {
        failure: {
          killed: false,
          error: `Failed to persist subagent kill intent: ${formatErrorMessage(
            error instanceof SubagentRegistryWriteError ? error.cause : error,
          )}`,
        },
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
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return {
        killed: false,
        error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
      };
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
    if (acceptance.callerFailure) {
      return cancellationFailure(acceptance.callerFailure.error, true);
    }
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
  const killSettlement = createSubagentKillSettlementOwner({
    currentEntry,
    isCurrent,
    assertState,
    targetState,
    getClaim: () => killClaim,
    releaseClaim: releaseKillClaim,
    session: params.session,
    stateContext,
    cancellationControl: params.cancellationControl,
    stopAcceptance,
    suppressTaskDelivery: params.suppressTaskDelivery,
    withdrawQueuedReservation: params.withdrawQueuedReservation,
  });
  const acceptance = createSubagentKillAcceptance({
    stopAcceptance,
    assertCallerCurrent: params.cancellationControl.assertCurrent,
    assertNativeCurrent: assertSelectedRun,
    ownsSessionIncarnation: killSettlement.ownsSessionIncarnation,
    isKillOwnerCurrent: killSettlement.isCurrent,
    commands,
  });
  const cancellation = runSessionMutation({
    diagnosticLabel: "subagent-kill",
    requiredSessionId: params.requiredSessionId,
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: acceptance.prepare(async () => {
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
      const declinedBeforeCapture = declineRevokedCancellation();
      if (declinedBeforeCapture) {
        preparationResult = await declinedBeforeCapture;
        return;
      }
      const captured = captureSubagentKillSources({
        target,
        entry: initial,
        exactRun,
        sessionId: captureSessionId,
        captureQueued: !gatewaySourceSelection && !exactRun,
      });
      capturedStop = captured.stop;
      capturedQueued = captured.queued;
      captureCleanup(captured.cleanup);
      const capturedPreparation = captured.preparation;
      // Admissions can release scheduler capacity synchronously when interrupted.
      await params.refreshDescendants();
      assertState();
      // The session fence is active before resolving/signaling other owners.
      // A refused full-session Stop must not interrupt their admissions or this collector.
      if (!legacy && params.beforeSessionKill) {
        commands?.observe(currentEntry());
      }
      const execution = captureExecution()?.execution;
      const executionAborted = () => execution?.input.abortSignal.aborted === true;
      const alreadyAborted = executionAborted();
      try {
        if (!legacy && (await params.beforeSessionKill?.()) === false) {
          admission = "declined";
          return;
        }
      } finally {
        // A caller hook can accept this exact abort before refusing or throwing.
        acceptance.accept(!alreadyAborted && executionAborted());
      }
      if (!isCurrent()) {
        return;
      }
      const declinedBeforeClaim = declineRevokedCancellation();
      if (declinedBeforeClaim) {
        preparationResult = await declinedBeforeClaim;
        return;
      }
      const beforeInterruption = currentEntry();
      if (!beforeInterruption) {
        return;
      }
      if (
        beforeInterruption.swarmLaunchPending !== true &&
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
          if (!killSettlement.ownsSessionIncarnation()) {
            preparationResult = await killSettlement.releaseChangedSession(killClaim);
            return;
          }
          if (!killSettlement.isCurrent()) {
            preparationResult = { killed: false, superseded: true };
            return;
          }
        }
      }
      const declinedBeforeInterruption = declineRevokedCancellation();
      if (declinedBeforeInterruption) {
        preparationResult = await declinedBeforeInterruption;
        return;
      }
      assertState();
      if (!killSettlement.isCurrent()) {
        preparationResult = { killed: false, superseded: true };
        return;
      }
      // Withdraw exact queued inputs and unbound preparation before draining admission;
      // active execution still follows the admission-then-abort sequence below.
      const preparationStop = cancelCapturedSessionControllerSource(capturedPreparation, {
        assertCurrent: killSettlement.assertCancellationCurrent,
        reason: createAgentRunDirectAbortError(),
        onCancelled: () => acceptance.accept(true),
      });
      acceptance.accept(preparationStop.activeCancelled > 0 && killSettlement.isCurrent());
      stopAcceptance.queuedOnly =
        exactRun &&
        preparationStop.queuedCancelled > 0 &&
        capturedStop.activeInputs.length === 0 &&
        capturedStop.operations.length === 0;
      killSettlement.assertCancellationCurrent();
      const executionForInterruption = captureExecution()?.execution;
      commands?.observe(currentEntry());
      // Exact cancellation must not interrupt another run's admission or queued input.
      if (exactRun) {
        for (const owned of captured.admissions) {
          if (acceptance.callerFailure) {
            break;
          }
          killSettlement.assertCancellationCurrent();
          acceptance.accept(owned.interrupt(createAgentRunDirectAbortError()));
        }
        const drained = await acceptance.drain(
          Promise.all(captured.admissions.map((owned) => owned.released)).then(() => undefined),
          () => stopAcceptance.accepted,
        );
        admission = drained ? "ready" : "busy";
        return;
      }
      const interruption = startSessionControllerInterruption({
        assertCurrent: killSettlement.assertCancellationCurrent,
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        reason: createAgentRunDirectAbortError(),
        requiredSessionId: params.requiredSessionId,
        admissionsOnly: true,
        // settleSubagentKillSources joins this exact source outside the kill mutation.
        deferSourceSettlement: executionForInterruption?.input,
      });
      const interruptedSelectedRun = () => {
        const selected = currentEntry();
        return (
          selected !== undefined &&
          killSettlement.isCurrent() &&
          (interruption.interruptedRunIds.has(params.entry.runId) ||
            interruption.interruptedRunIds.has(selected.runId))
        );
      };
      const released = await acceptance.drain(interruption.released, interruptedSelectedRun);
      admission = released ? "ready" : "busy";
      acceptance.accept(interruptedSelectedRun());
      // Native preaccept cancellation first returns its recorded abort outcome.
      // Claim before another worker read lets that response adopt the queued row.
      const afterInterruption = currentEntry();
      if (
        released &&
        !acceptance.callerFailure &&
        params.beforeSessionKill &&
        afterInterruption?.swarmLaunchPending === true &&
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
    }),
    run: async (): Promise<Awaited<ReturnType<typeof mutateSubagentRunForKill>>> => {
      if (preparationResult) {
        return preparationResult;
      }
      if (acceptance.preparationFailed) {
        return killClaim ? await killSettlement.settle(killClaim) : { killed: false };
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
      if (killClaim && !killSettlement.ownsSessionIncarnation()) {
        return killSettlement.releaseChangedSession(killClaim);
      }
      if (!isCurrent()) {
        return { killed: false, superseded: true };
      }
      if (!readFailure && !acceptance.callerFailure) {
        await params.refreshDescendants();
      }
      if (!isCurrent()) {
        return { killed: false, superseded: true };
      }
      const targetStateAfterAdmission = targetState();
      if (targetStateAfterAdmission) {
        const killedTarget = isKilledSubagentTarget(targetStateAfterAdmission);
        const claimedCurrentKill = killClaim !== undefined && killSettlement.isCurrent();
        if (killedTarget && (!killClaim || claimedCurrentKill)) {
          await markKilledBestEffort();
        }
        return await killSettlement.retireObligations({
          killed: killedTarget && claimedCurrentKill,
          targetState: targetStateAfterAdmission,
          ...(readFailure ? { error: formatErrorMessage(readFailure.error) } : {}),
        });
      }
      const declined =
        readFailure || acceptance.callerFailure ? undefined : declineRevokedCancellation();
      if (declined && !stopAcceptance.accepted) {
        return declined;
      }
      if (!killClaim) {
        if (acceptance.callerFailure) {
          return { killed: false };
        }
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
      try {
        if (readFailure || declined || acceptance.callerFailure) {
          // Missing caller facts or revocation fence new effects, but the accepted
          // interruption's exact claim still owns settlement.
          const settled: Awaited<ReturnType<typeof mutateSubagentRunForKill>> =
            await killSettlement.settle(claimedKill);
          return readFailure
            ? {
                ...settled,
                error: [settled.error, formatErrorMessage(readFailure.error)]
                  .filter(Boolean)
                  .join(" "),
              }
            : settled;
        }
        if (!runtime) {
          try {
            runtime = await subagentKillRuntimeLoader.load();
          } catch (error) {
            if (hasSqliteWorkerOutcomeUnknown(error)) {
              throw error;
            }
            return cancellationFailure(error);
          }
          // Continue through the native and caller guards below without reopening
          // pre-claim admission, which could release an already committed kill intent.
        }
        const active = capturedStop?.operations.some((operation) => !operation.result) === true;
        if (!killSettlement.ownsSessionIncarnation()) {
          return killSettlement.releaseChangedSession(claimedKill);
        }
        const declinedBeforeAbort = declineRevokedCancellation();
        if (declinedBeforeAbort) {
          return stopAcceptance.accepted
            ? await killSettlement.settle(claimedKill)
            : declinedBeforeAbort;
        }
        if (!killSettlement.isCurrent()) {
          return { killed: false, superseded: true };
        }
        commands?.observe(currentEntry());
        const stopped = capturedStop
          ? cancelCapturedSessionControllerSource(capturedStop, {
              assertCurrent: killSettlement.assertCancellationCurrent,
              reason: createAgentRunDirectAbortError(),
              onCancelled: () => acceptance.accept(true),
            })
          : undefined;
        acceptance.accept((stopped?.activeCancelled ?? 0) > 0);
        if (exactRun) {
          stopAcceptance.queuedOnly ||=
            (stopped?.queuedCancelled ?? 0) > 0 && stopped?.activeCancelled === 0;
          acceptance.accept((stopped?.queuedCancelled ?? 0) > 0);
          if (!stopAcceptance.accepted && commands) {
            acceptance.accept(commands.cancel(killSettlement.assertCancellationCurrent));
          }
        }
        if (acceptance.callerFailure) {
          return await killSettlement.settle(claimedKill);
        }
        // Without a captured controller record nothing is cancelled here; the kill
        // settles registry state alone and never re-selects a turn by session ID.
        const noControllerRecord = !capturedStop?.inputs.length && !capturedStop?.operations.length;
        // Native cancellation is a request. Only the captured producer can settle its raw work;
        // a producer that ignores it must not hold the caller's Stop past the drain bound.
        const refused = capturedRuntimeRefused();
        if (!killSettlement.ownsSessionIncarnation()) {
          return killSettlement.releaseChangedSession(claimedKill);
        }
        const declinedBeforeQueueClear = declineRevokedCancellation();
        if (declinedBeforeQueueClear) {
          return stopAcceptance.accepted
            ? await killSettlement.settle(claimedKill)
            : declinedBeforeQueueClear;
        }
        if (!killSettlement.isCurrent()) {
          return { killed: false, superseded: true };
        }
        // Narrow Gateway Stop already cancelled its captured authorized sources.
        // Rediscovering key-wide queues here would include preserved incarnations.
        const selected = capturedQueued
          .filter(
            ({ input, source, target: sourceTarget, mailbox }) =>
              !input.claim &&
              input.source === source &&
              input.target === sourceTarget &&
              input.mailbox === mailbox,
          )
          .map(({ input }) => input);
        if (!gatewaySourceSelection && !exactRun) {
          runtime.clearSessionQueues(
            [childSessionKey, sessionId],
            target,
            selected,
            killSettlement.assertCancellationCurrent,
          );
        }
        if (refused || (active && !stopAcceptance.accepted)) {
          return stillActive();
        }
        const settledTarget = targetState();
        if (settledTarget) {
          const killedTarget = isKilledSubagentTarget(settledTarget);
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
          return await killSettlement.retireObligations({
            killed: killedTarget,
            targetState: settledTarget,
          });
        }
        const settled = await killSettlement.settle(claimedKill);
        return noControllerRecord ? { ...settled, reason: "no_controller_record" } : settled;
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        return { killed: false, error: formatErrorMessage(error) };
      }
    },
    finalize: async () => {
      // Preparation now owns the claim, including failed drains and persistence.
      // Only its exact retained claim may withdraw the captured reservation.
      if (killClaim && killSettlement.ownsIntent(currentEntry(), killClaim)) {
        params.withdrawQueuedReservation();
      }
    },
  });
  return await acceptance.finish(cancellation, { settleCommands: params.commands === undefined });
}
