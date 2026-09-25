/** Session-lifecycle mutation and persistence for subagent kills. */

import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  captureChatAbortExecution,
  isCurrentChatAbortExecution,
} from "../../../gateway/chat-abort-lifecycle-internal.js";
import { logVerbose } from "../../../globals.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-context-binding.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
  waitForSessionWorkAdmissionRelease,
} from "../../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import type { TaskCancellationControl } from "../../../tasks/task-cancellation-context.js";
import type { SubagentKillTargetState } from "../../../tasks/task-registry-control.types.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { isCurrentSubagentRun } from "./subagent-control-scope.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { subagentRuns } from "./subagent-registry-memory.js";
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
            lastEventAt: taskEndedAt,
            error: SUBAGENT_KILL_TASK_ERROR,
            progressSummary: entry.completion?.resultText ?? undefined,
            terminalSummary: null,
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

export async function persistSubagentAbortedLastRun(params: {
  childSessionKey: string;
  storePath: string;
  hasSessionEntry: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  abortedLastRun: boolean;
  isCurrent?: (current: SessionEntry) => boolean;
  assertCommitAllowed?: () => void;
  strict?: boolean;
}): Promise<boolean> {
  if (!params.hasSessionEntry) {
    return true;
  }
  try {
    await patchSessionEntryCore(
      { storePath: params.storePath, sessionKey: params.childSessionKey },
      (current) =>
        current.sessionId !== params.expectedSessionId ||
        current.lifecycleRevision !== params.expectedLifecycleRevision ||
        params.isCurrent?.(current) === false
          ? null
          : {
              ...current,
              abortedLastRun: params.abortedLastRun,
              updatedAt: Date.now(),
            },
      {
        assertCommitAllowed: params.assertCommitAllowed,
        replaceEntry: true,
      },
    );
    return true;
  } catch (error) {
    if (params.strict) {
      throw error;
    }
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): number {
  try {
    return markSubagentRunTerminated(params);
  } catch (error) {
    // The registry transition rolled back atomically. Keep multi-run control
    // moving so one persistence failure cannot leave siblings running.
    logVerbose(
      `subagents control kill: failed to persist ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

export function resolveSubagentKillSession(cfg: OpenClawConfig, sessionKey: string) {
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: parseAgentSessionKey(sessionKey)?.agentId,
  });
  return {
    storePath,
    entry: loadExactSessionEntryReadOnly({ storePath, sessionKey, clone: false })?.entry,
  };
}

export function captureSubagentExecution(params: {
  entry: SubagentRunRecord;
  session: ReturnType<typeof resolveSubagentKillSession>;
}) {
  const resolver = getGatewayContextResolver(params.entry);
  const context = resolver?.();
  const runId = params.entry.runId;
  const execution =
    context &&
    captureChatAbortExecution({
      entries: context.chatAbortControllers,
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId: params.session.entry?.sessionId,
      lifecycleGeneration: params.entry.execution.lifecycleGeneration,
    });
  return context && execution ? { resolver, context, runId, execution } : undefined;
}

export async function killSubagentRun(
  params: Parameters<typeof mutateSubagentRunForKill>[0],
): ReturnType<typeof mutateSubagentRunForKill> {
  let captured = captureSubagentExecution(params);
  const stopAcceptance = { accepted: false };
  const initialTargetState = resolveSubagentKillTargetState(params.entry);
  let result: Awaited<ReturnType<typeof mutateSubagentRunForKill>> = {
    killed: false,
    targetState: initialTargetState,
  };
  let settlementFailure: { error: unknown } | undefined;
  try {
    result = await mutateSubagentRunForKill(
      params,
      () => {
        // An accepted registration may arrive while the mutation waits for its fence.
        captured ??= captureSubagentExecution(params);
      },
      initialTargetState,
      stopAcceptance,
    );
  } finally {
    // Runtime disposal may mutate this session. Join only after the exclusive
    // mutation exits; the caller still holds the selected retirement/reservation.
    const execution = captured?.execution;
    if (
      execution &&
      !isCurrentChatAbortExecution(execution) &&
      (result.killed ||
        result.targetState ||
        execution.controller.signal.aborted ||
        execution.registrationCleanupRequested ||
        execution.executionSettlement?.status === "rejected")
    ) {
      // A refused or pre-interruption failure must not await work it left running.
      try {
        await execution.executionSettlement?.completion;
      } catch (error) {
        settlementFailure = { error };
      }
    }
  }
  // Revocation fences new effects, not the outcome of this accepted Stop.
  if (!stopAcceptance.accepted) {
    params.cancellationControl?.assertCurrent();
  }
  if (
    captured &&
    (params.entry.runId !== captured.runId ||
      getGatewayContextResolver(params.entry) !== captured.resolver ||
      captured.resolver?.() !== captured.context ||
      (captured.context.chatAbortControllers.has(captured.runId) &&
        captured.context.chatAbortControllers.get(captured.runId) !== captured.execution))
  ) {
    throw new Error("Subagent execution owner changed during cancellation");
  }
  if (settlementFailure) {
    // The accepted parent's cleanup failure must not skip its captured descendants.
    result = {
      ...result,
      error: [
        result.error,
        `Subagent execution settlement failed: ${formatErrorMessage(settlementFailure.error)}`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  return params.isCurrent?.(params.entry) === false
    ? { ...result, killed: false, superseded: true }
    : result;
}

async function mutateSubagentRunForKill(
  params: {
    cfg: OpenClawConfig;
    entry: SubagentRunRecord;
    session: ReturnType<typeof resolveSubagentKillSession>;
    cancellationControl?: TaskCancellationControl;
    suppressTaskDelivery?: boolean;
    beforeSessionKill?: () => boolean;
    isCurrent?: (entry: SubagentRunRecord) => boolean;
    withdrawQueuedReservation: () => void;
    refreshDescendants: () => void;
  },
  captureExecution: () => void,
  initialTargetState: SubagentKillTargetState | undefined,
  stopAcceptance: { accepted: boolean },
): Promise<{
  killed: boolean;
  sessionId?: string;
  superseded?: boolean;
  declined?: true;
  targetState?: SubagentKillTargetState;
  error?: string;
}> {
  const isCurrent = () =>
    isCurrentSubagentRun(params.entry, params.cfg) && params.isCurrent?.(params.entry) !== false;
  const markKilledBestEffort = () =>
    markSubagentRunTerminatedBestEffort({
      runId: params.entry.runId,
      reason: "killed",
      suppressTaskDelivery: params.suppressTaskDelivery,
    });
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
      markKilledBestEffort();
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
  let killClaim: ReturnType<typeof claimSubagentRunKill>;
  let preparationResult: Awaited<ReturnType<typeof killSubagentRun>> | undefined;
  const cancellationFailure = (
    error: unknown,
    declined?: true,
  ): NonNullable<typeof preparationResult> => {
    let reason = formatErrorMessage(error);
    if (killClaim && !stopAcceptance.accepted) {
      try {
        releaseSubagentRunKillClaim({
          runId: params.entry.runId,
          expected: params.entry,
          claim: killClaim,
        });
      } catch (releaseError) {
        reason += ` Kill intent could not be released: ${formatErrorMessage(releaseError)}`;
      }
    }
    return { killed: false, sessionId, ...(declined ? { declined } : {}), error: reason };
  };
  const declineRevokedCancellation = (): typeof preparationResult => {
    try {
      params.cancellationControl?.assertCurrent();
      return undefined;
    } catch (error) {
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
    const currentSessionEntry = loadExactSessionEntryReadOnly({
      storePath: resolved.storePath,
      sessionKey: childSessionKey,
      clone: false,
    })?.entry;
    return (
      (currentSessionEntry !== undefined) === (resolved.entry !== undefined) &&
      currentSessionEntry?.sessionId === sessionId &&
      currentSessionEntry?.lifecycleRevision === sessionLifecycleRevision
    );
  };
  const releaseChangedSessionKill = (claim: NonNullable<typeof killClaim>) => {
    try {
      releaseSubagentRunKillClaim({
        runId: params.entry.runId,
        expected: params.entry,
        claim,
      });
    } catch (error) {
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
      preparationResult = declineRevokedCancellation();
      if (preparationResult) {
        return;
      }
      // Admissions can release scheduler capacity synchronously when interrupted.
      params.refreshDescendants();
      // The session fence is active before resolving/signaling other owners.
      // A refused full-session Stop must not interrupt their admissions or this collector.
      captureExecution();
      if (params.beforeSessionKill?.() === false) {
        admission = "declined";
        return;
      }
      if (!isCurrent()) {
        return;
      }
      preparationResult = declineRevokedCancellation();
      if (preparationResult) {
        return;
      }
      if (
        params.entry.swarmLaunchPending !== true &&
        params.entry.execution.restartRecovery === undefined &&
        !resolveSubagentKillTargetState(params.entry)
      ) {
        try {
          // Active completion must see cancellation before admission interruption.
          // Pending launch/recovery owners first need the drain to commit their identity.
          killClaim = claimSubagentRunKill({
            runId: params.entry.runId,
            expected: params.entry,
            sessionId,
            sessionLifecycleRevision,
            suppressTaskDelivery: params.suppressTaskDelivery,
          });
        } catch (error) {
          preparationResult = {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill intent: ${formatErrorMessage(error)}`,
          };
          return;
        }
        if (killClaim) {
          if (!ownsSessionIncarnation()) {
            preparationResult = releaseChangedSessionKill(killClaim);
            return;
          }
          if (!killOwnerCurrent()) {
            preparationResult = { killed: false, sessionId, superseded: true };
            return;
          }
        }
      }
      preparationResult = declineRevokedCancellation();
      if (preparationResult) {
        return;
      }
      const interruption = startSessionWorkAdmissionInterruption({
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        reason: createAgentRunDirectAbortError(),
      });
      stopAcceptance.accepted =
        interruption.interruptedRunIds.has(params.entry.runId) && killOwnerCurrent();
      const released = await waitForSessionWorkAdmissionRelease(
        interruption.released,
        SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      );
      admission = released ? "ready" : "busy";
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
          if (killClaim && !stopAcceptance.accepted) {
            releaseSubagentRunKillClaim({
              runId: params.entry.runId,
              expected: params.entry,
              claim: killClaim,
            });
          }
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: stopAcceptance.accepted
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
        if (!stopAcceptance.accepted) {
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
        params.refreshDescendants();
      }
      const targetStateAfterRuntimeLoad = resolveSubagentKillTargetState(params.entry);
      if (targetStateAfterRuntimeLoad) {
        const killedTarget =
          params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          params.entry.suppressAnnounceReason !== "steer-restart";
        const claimedCurrentKill = killClaim !== undefined && killOwnerCurrent();
        if (killedTarget && (!killClaim || claimedCurrentKill)) {
          markKilledBestEffort();
        }
        return {
          killed: killedTarget && claimedCurrentKill,
          sessionId,
          targetState: targetStateAfterRuntimeLoad,
          ...(readFailure ? { error: formatErrorMessage(readFailure.error) } : {}),
        };
      }
      const declined = readFailure ? undefined : declineRevokedCancellation();
      if (declined && !stopAcceptance.accepted) {
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
            if (!killOwnerCurrent()) {
              throw new Error("subagent kill lifecycle retired before abort-marker commit");
            }
          },
          strict,
        });
      if (!killClaim) {
        try {
          killClaim = claimSubagentRunKill({
            runId: params.entry.runId,
            expected: params.entry,
            sessionId,
            sessionLifecycleRevision,
            suppressTaskDelivery: params.suppressTaskDelivery,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill intent: ${formatErrorMessage(error)}`,
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
          marked = markSubagentRunTerminated({
            runId: params.entry.runId,
            reason: "killed",
            suppressTaskDelivery: params.suppressTaskDelivery,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Failed to persist subagent kill tombstone: ${formatErrorMessage(error)}`,
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
          return stopAcceptance.accepted ? await settleTargetCancellation() : declinedBeforeAbort;
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
        const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
        if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
          logVerbose(
            `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
          );
        }
        if (active && !stopAcceptance.accepted) {
          try {
            releaseSubagentRunKillClaim({
              runId: params.entry.runId,
              expected: params.entry,
              claim: killClaim,
            });
          } catch (error) {
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
            markKilledBestEffort();
          } else {
            try {
              releaseSubagentRunKillClaim({
                runId: params.entry.runId,
                expected: params.entry,
                claim: killClaim,
              });
            } catch (error) {
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
