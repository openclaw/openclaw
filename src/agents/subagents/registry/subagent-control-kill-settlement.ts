import { isSessionDeliveryGenerationRevokedError } from "../../../config/sessions/session-delivery-generation.js";
import { logVerbose } from "../../../globals.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { PluginRuntimeCloseCompletedError } from "../../../plugins/runtime-close-error.js";
import {
  getCurrentSessionControllerOwner,
  isCurrentSessionControllerTurnInput,
} from "../../../sessions/session-controller.context.js";
import {
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  waitForSessionControllerSettlement,
} from "../../../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../../../sessions/session-controller.rpc-sources.js";
import type { SessionControllerStopCapture } from "../../../sessions/session-controller.stop.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { matchesSubagentKillIntent } from "./subagent-control-kill-intent.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type SubagentCancellationControl,
  type SubagentRunKillResult,
  type SubagentKillTargetState,
} from "./subagent-control.types.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  claimSubagentRunKill,
  markSubagentRunTerminated,
  retireSubagentObligations,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSubagentObligationRetired } from "./subagent-requester-settle-identity.js";

type SubagentKillClaim = NonNullable<Awaited<ReturnType<typeof claimSubagentRunKill>>>;

type SubagentKillSettlementOwnerParams = {
  currentEntry: () => SubagentRunRecord | undefined;
  isCurrent: () => boolean;
  assertState: () => void;
  targetState: () => SubagentKillTargetState | undefined;
  getClaim: () => SubagentKillClaim | undefined;
  releaseClaim: (claim: SubagentKillClaim) => Promise<boolean>;
  session: SubagentKillSession;
  stateContext: OpenClawStateWorkerContext;
  cancellationControl: Pick<SubagentCancellationControl, "assertCurrent">;
  stopAcceptance: { accepted: boolean };
  suppressTaskDelivery?: boolean;
  withdrawQueuedReservation: () => void;
};

/** Identifies the terminal state produced by an accepted subagent kill. */
export function isKilledSubagentTarget(state: SubagentKillTargetState): boolean {
  return (
    state.state === "terminal" &&
    state.task.status === "cancelled" &&
    state.task.error === SUBAGENT_KILL_TASK_ERROR
  );
}

/** Owns durable kill-claim validation, release, and terminal settlement. */
export function createSubagentKillSettlementOwner(params: SubagentKillSettlementOwnerParams) {
  const ownsIntent = (current: SubagentRunRecord | undefined, claim: SubagentKillClaim) =>
    matchesSubagentKillIntent(current?.killIntent, claim);

  const isCurrent = () => {
    const current = params.currentEntry();
    const claim = params.getClaim();
    return (
      current !== undefined &&
      params.isCurrent() &&
      (!claim ||
        ((ownsIntent(current, claim) ||
          (!current.killIntent &&
            current.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
            current.killReconciliation?.killedAt === claim.requestedAt &&
            current.killReconciliation.taskCancellationAccepted === true &&
            current.execution.lifecycleGeneration === claim.lifecycleGeneration)) &&
          (claim.lifecycleGeneration === undefined ||
            isAgentEventLifecycleGenerationCurrent(claim.lifecycleGeneration))))
    );
  };

  const ownsSessionIncarnation = () => {
    try {
      params.assertState();
      return true;
    } catch (error) {
      if (isSessionDeliveryGenerationRevokedError(error)) {
        return false;
      }
      throw error;
    }
  };

  const assertCancellationCurrent = () => {
    params.cancellationControl.assertCurrent();
    if (!isCurrent() || !ownsSessionIncarnation()) {
      throw new Error("Subagent ownership changed before cancellation; retry.");
    }
  };

  const releaseChangedSession = async (
    claim: SubagentKillClaim,
  ): Promise<SubagentRunKillResult> => {
    try {
      await params.releaseClaim(claim);
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      return {
        killed: false,
        error: `Subagent session changed and its kill intent could not be released: ${formatErrorMessage(error)}`,
      };
    }
    return {
      killed: false,
      error: "Subagent session changed while the kill was pending; retry.",
    };
  };

  // A committed kill ends the row's completion obligation, including its owed inputs.
  const retireObligations = async (
    result: SubagentRunKillResult,
  ): Promise<SubagentRunKillResult> => {
    const current = params.currentEntry();
    if (!current || !isSubagentObligationRetired(current)) {
      return result;
    }
    try {
      // The killed row may already have a successor; retirement binds to this exact row.
      await retireSubagentObligations(
        current,
        () => {
          const selected = getCurrentSubagentRunOwner(subagentRuns, current);
          if (!selected || !isSubagentObligationRetired(selected)) {
            throw new Error("Killed subagent row changed before obligation retirement.");
          }
        },
        { requesterNotified: params.suppressTaskDelivery },
      );
      return result;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const failure = `Subagent obligation retirement failed: ${formatErrorMessage(error)}`;
      return { ...result, error: [result.error, failure].filter(Boolean).join(" ") };
    }
  };

  const settleKill = async (claim: SubagentKillClaim): Promise<SubagentRunKillResult> => {
    if (!ownsSessionIncarnation()) {
      return releaseChangedSession(claim);
    }
    if (!isCurrent()) {
      return { killed: false, superseded: true };
    }
    const selected = params.currentEntry();
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
        context: params.stateContext,
        assertCurrent: () => {
          params.assertState();
          if (!params.stopAcceptance.accepted) {
            params.cancellationControl.assertCurrent();
          }
          if (!isCurrent()) {
            throw new Error("Subagent kill settlement lost its original claim.");
          }
        },
        assertPublicationCurrent: () => {
          params.assertState();
          if (!isCurrent()) {
            throw new Error("Subagent kill publication lost its original claim");
          }
        },
        onPublished: (count) => {
          marked = count;
        },
      });
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const action =
        marked > 0 ? "finish subagent kill cleanup" : "persist subagent kill tombstone";
      return {
        killed: marked > 0,
        error: `Failed to ${action}: ${formatErrorMessage(error)}`,
      };
    }
    if (marked === 0) {
      params.assertState();
      if (!params.isCurrent()) {
        return { killed: false, superseded: true };
      }
      return {
        killed: false,
        targetState: params.targetState(),
      };
    }
    return { killed: true };
  };
  const settle = async (claim: SubagentKillClaim) => retireObligations(await settleKill(claim));

  return {
    assertCancellationCurrent,
    isCurrent,
    ownsIntent,
    ownsSessionIncarnation,
    releaseChangedSession,
    retireObligations,
    settle,
  };
}

export async function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): Promise<number> {
  try {
    return await markSubagentRunTerminated(params);
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    // A persistence failure must not leave the other siblings running.
    logVerbose(
      `subagents control kill: failed to persist ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

/** Raw disposal may need its own session mutation, so join only after releasing the kill fence. */
export async function settleSubagentKillSources(params: {
  cleanup?: SessionControllerStopCapture;
  execution?: RpcSourceRef;
}): Promise<{ failure?: { error: unknown; cleanupCompleted: boolean } }> {
  const current = getCurrentSessionControllerOwner();
  // A synchronous abort observer can revoke authority before later captured owners
  // are touched. Join interrupted or completed custody, never those untouched peers.
  // The caller separately selects exact execution cleanup, including terminal rows
  // whose controller turn is still finishing.
  const inputs = new Set(
    [
      ...(params.cleanup?.inputs ?? []).filter(
        (input) =>
          input.abortSignal.aborted ||
          input.retirementRequested ||
          input.custody.failure !== undefined ||
          Boolean(input.claim?.operation?.result),
      ),
      ...(params.execution ? [params.execution.input] : []),
    ].filter((input) => !isCurrentSessionControllerTurnInput(input)),
  );
  const operations = new Set(
    [
      ...(params.cleanup?.operations ?? []),
      ...(params.cleanup?.activeInputs.flatMap((input) => input.claim?.operation ?? []) ?? []),
    ].filter(
      (operation) =>
        operation !== current && (operation.abortSignal.aborted || Boolean(operation.result)),
    ),
  );
  const result = Promise.allSettled([
    ...[...inputs].map((input) => input.settlement.promise),
    ...[...operations].map((operation) => operation.ownerSettlement),
  ]);
  if (
    !(await waitForSessionControllerSettlement(
      result.then(() => undefined),
      SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
    ))
  ) {
    return {
      failure: {
        error: new Error("Subagent execution cleanup remains pending after its drain deadline."),
        cleanupCompleted: false,
      },
    };
  }
  const failures = (await result).flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  const completedFailure = (error: unknown): boolean =>
    error instanceof PluginRuntimeCloseCompletedError ||
    (error instanceof AggregateError &&
      error.errors.length > 0 &&
      error.errors.every(completedFailure));
  return failures.length
    ? {
        failure: {
          error:
            failures.length === 1
              ? failures[0]
              : new AggregateError(failures, "Subagent source cleanup failed"),
          cleanupCompleted: failures.every(completedFailure),
        },
      }
    : {};
}
