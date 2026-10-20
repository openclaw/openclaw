import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import type { SessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { isSessionControllerWorkActive } from "../../../sessions/session-controller.lifecycle.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { isQuietSubagentRestartContinuation } from "./subagent-recovery-state.js";
import { getUnrestorableSubagentCompletionSourceReason } from "./subagent-registry-gateway-owner.js";
import {
  getSubagentRunsForRequesterSession,
  getSubagentRunsForChildSession,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import {
  isRestartRecoveryLifecycleCurrent,
  ownsSubagentSessionExecution,
} from "./subagent-registry-restart-recovery-helpers.js";
import {
  loadSubagentRecoverySession,
  markSubagentRecoverySessionInterrupted,
} from "./subagent-registry-restart-recovery-session.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery-types.js";
import type { SubagentRunRecord, SubagentSessionEffects } from "./subagent-registry.types.js";
import {
  hasRequesterCompletionCohort,
  isRequesterCompletionCohortCurrent,
  isRequesterSettleWakeForRun,
  sameRequesterSettleRunIdentity,
} from "./subagent-requester-settle-identity.js";
import { isSameSubagentRunOwner, latestSubagentRun } from "./subagent-run-generation.js";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

type RequesterSettleWakeRecoveryTarget = {
  runId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
  sessionId: string;
  lifecycleRevision?: string;
  storePath: string;
  gatewayRuntime: GatewayRecoveryRuntime;
};

/** The dispatched frozen cohort owns this exact requester input across a restart. */
function findRequesterSettleWakeRecoveryBatch(
  params: RequesterSettleWakeRecoveryTarget,
  requireGatewayCurrent = true,
  allowPending = false,
): SubagentRunRecord[] | undefined {
  const children = new Map(
    [...getSubagentRunsForRequesterSession(params.requesterSessionKey)].map((child) => [
      child.runId,
      child,
    ]),
  );
  for (const child of children.values()) {
    const wake = child.requesterSettleWake;
    if (
      !(wake?.status === "dispatching" || (allowPending && wake?.status === "pending")) ||
      wake.attemptCount < 1 ||
      !(hasRequesterCompletionCohort(child) || isQuietSubagentRestartContinuation(child)) ||
      !isRequesterSettleWakeForRun({
        entry: child,
        runId: params.runId,
        requesterSessionKey: params.requesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        runsById: children,
      })
    ) {
      continue;
    }
    const batch = (
      child.pauseReason === "sessions_yield" && wake.pauseNotice
        ? [child.runId]
        : (wake.batchRunIds ?? [])
    ).flatMap((id) => {
      const member = children.get(id);
      return member?.requesterSettleWake !== undefined &&
        member.requesterSettleWake.rearmGeneration === wake.rearmGeneration
        ? [member]
        : [];
    });
    if (
      batch.length > 0 &&
      batch.every(
        (member) =>
          isRequesterCompletionCohortCurrent(
            member,
            (key, matches, agentId) =>
              latestSubagentRun(getSubagentRunsForChildSession(key, agentId), matches) ?? null,
          ) &&
          (member.expectsCompletionMessage === true ||
            isQuietSubagentRestartContinuation(member)) &&
          !member.collect &&
          member.completionRequesterSessionId === params.sessionId &&
          (member.completionTarget !== "parent" ||
            member.completionRequesterLifecycleRevision === params.lifecycleRevision) &&
          member.requesterStorePath === params.storePath &&
          member.requesterAgentId === params.requesterAgentId &&
          !member.suppressCompletionDelivery &&
          !member.killReconciliation?.suppressTaskDelivery &&
          (member.requesterSettleWake?.status === "dispatching" ||
            (allowPending && member.requesterSettleWake?.status === "pending")) &&
          member.requesterSettleWake.rearmGeneration === wake.rearmGeneration &&
          member.requesterSettleWake.attemptCount === wake.attemptCount &&
          (!requireGatewayCurrent ||
            getGatewayContextResolver(member)?.()?.recoveryRuntime === params.gatewayRuntime),
      )
    ) {
      return batch;
    }
  }
  return undefined;
}

export async function captureRequesterSettleWakeRecoverySource(
  params: RequesterSettleWakeRecoveryTarget & {
    context: OpenClawStateWorkerContext;
    requesterOperatorSourceMissing?: true;
  },
): Promise<
  | { status: "ready"; source: SessionSourceAssertion }
  | { status: "unrestorable"; reason: string }
  | undefined
> {
  assertSubagentRegistryWriteSourceCurrent(params.context);
  const lifecycleGeneration = agentEvents.getAgentEventLifecycleGeneration();
  // A retry can return the wake to pending without revoking its admitted source.
  const batch = findRequesterSettleWakeRecoveryBatch(params, true, true);
  if (!batch) {
    if (findRequesterSettleWakeRecoveryBatch(params, false, true)) {
      throw new Error("Requester settle recovery awaits its current Gateway binding");
    }
    return undefined;
  }
  const assertBatchCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(params.context);
    const current = findRequesterSettleWakeRecoveryBatch(params, true, true);
    if (
      !agentEvents.isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
      !current ||
      current.length !== batch.length ||
      !batch.every((observed) =>
        current.some(
          (member) =>
            isSameSubagentRunOwner(member, observed) &&
            sameRequesterSettleRunIdentity(member, observed) &&
            member.requesterSettleWake?.attemptCount ===
              observed.requesterSettleWake?.attemptCount &&
            member.requesterSettleWake?.yieldedFinalDeliverable ===
              observed.requesterSettleWake?.yieldedFinalDeliverable,
        ),
      )
    ) {
      throw new Error("Requester settle recovery lost its exact dispatched cohort");
    }
    return current;
  };
  const unavailableReason = params.requesterOperatorSourceMissing
    ? "The original operator source was not saved for this requester continuation"
    : batch
        .map(getUnrestorableSubagentCompletionSourceReason)
        .find((reason) => reason !== undefined);
  if (unavailableReason) {
    const { mutateRequesterCompletionBatch } =
      await import("../completion/subagent-completion-admission.store.js");
    const settled = await mutateRequesterCompletionBatch({
      entries: batch,
      context: params.context,
      assertCurrent: assertBatchCurrent,
      operation: {
        kind: "settle",
        outcome: {
          delivered: false,
          path: "none",
          disposition: "permanent_failure",
          reason: "operator_authority_unavailable",
          error: unavailableReason,
        },
      },
    });
    if (!settled.applied || settled.publication !== "published") {
      throw new Error("Requester settle recovery awaits terminal cohort settlement");
    }
    return { status: "unrestorable", reason: unavailableReason };
  }
  const assertCurrent = () => {
    const current = assertBatchCurrent();
    // This checks retained cohort custody; the durable operator source restores
    // its principal separately when the Gateway admits the recovery run.
    subagentRuns.runWithCompletionBatchAuthority(current, () => {});
  };
  assertCurrent();
  return {
    status: "ready",
    source: Object.assign(assertCurrent, {
      nativeSource: true,
      async prepareSessionSource() {
        assertCurrent();
        return { nativeSource: true, checks: [], assertCurrent };
      },
    }),
  };
}

export async function recoverInterruptedSubagentRow(
  params: RestartRecoveryParams,
): Promise<RestartRecoveryResult> {
  const { entry, runId } = params;
  const authority = resolveSubagentChildAuthority(entry);
  if (authority.status === "mismatch") {
    params.warn("retained subagent record cannot be recovered", {
      runId,
      childSessionKey: entry.childSessionKey,
      error: new Error(authority.error),
    });
    return { status: "deferred" };
  }
  let expectedObservation = entry;
  const childSessionKey = entry.childSessionKey.trim();
  const lifecycleGeneration = agentEvents.getAgentEventLifecycleGeneration();
  const isGatewayCurrent = () =>
    agentEvents.isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
    params.isGatewayCurrent?.() !== false;
  const isCurrent = () =>
    isGatewayCurrent() &&
    params.isCurrent(runId, expectedObservation) &&
    expectedObservation.pauseReason !== "sessions_yield" &&
    expectedObservation.suppressAnnounceReason !== "steer-restart" &&
    !expectedObservation.killIntent &&
    !expectedObservation.killReconciliation &&
    expectedObservation.execution.status !== "queued";
  if (!childSessionKey || !isCurrent()) {
    return { status: "ignored" };
  }
  const terminalError =
    entry.terminalOwner === "interrupted-recovery" &&
    entry.pauseReason !== "sessions_yield" &&
    entry.execution.status === "terminal" &&
    typeof entry.execution.endedAt === "number" &&
    entry.execution.outcome?.status === "error" &&
    entry.endedReason === "subagent-error"
      ? (entry.execution.outcome.error ?? "subagent run interrupted by gateway restart")
      : undefined;
  const replayTerminal = terminalError !== undefined;
  if (!replayTerminal && typeof entry.execution.endedAt === "number") {
    return { status: "ignored" };
  }
  try {
    let session = await loadSubagentRecoverySession({ entry, isOwnerCurrent: isCurrent }).catch(
      (error: unknown) => {
        if (!replayTerminal) {
          throw error;
        }
        params.warn("could not verify child session effects for saved terminal result", {
          runId,
          childSessionKey,
          error,
        });
        return null;
      },
    );
    if ((!session && !replayTerminal) || !isCurrent()) {
      return { status: "deferred" };
    }
    if (session?.replacementReason) {
      return {
        status: "terminal",
        recoveryCurrent: {
          isHostCurrent: isCurrent,
          prepare: async () => isCurrent(),
          onPublished: (published) => {
            expectedObservation = published;
          },
        },
        error: terminalError ?? session.replacementReason,
        endedAt: replayTerminal ? entry.execution.endedAt : undefined,
        suppressSessionEffects: true,
      };
    }
    const legacy = authority.status === "legacy-unverified";
    if (!replayTerminal && session?.retained?.isCurrent()) {
      return { status: "handled", retained: session.retained };
    }
    // Registry custody stores the physical locator; session configuration may
    // still name its logical sessions.json alias. Let the store owner resolve it.
    const physicalStorePath =
      session && !replayTerminal && !entry.execution.restartRecovery
        ? (
            await prepareSqliteTargetFromSessionStorePath(session.storePath, {
              agentId: session.agentId,
            })
          ).path
        : undefined;
    if (!isCurrent()) {
      return { status: "deferred" };
    }
    const sessionId = session?.sessionEntry?.sessionId;
    const lifecycleRevision = session?.sessionEntry?.lifecycleRevision;
    const lifecycleRunId = session?.sessionEntry?.lifecycleRunId;
    const sessionAgentId = session?.agentId;
    const target = { sessionKey: childSessionKey, sessionId };
    // A requester can itself be a subagent. Its incoming continuation batch,
    // not the requester's outgoing parent notice, owns this exact saved attempt.
    // This only defers orphan settlement; the wake still owns replay admission,
    // failure/cancellation, and removal of the continuation obligation.
    const hasPendingRequesterSettleWake = () => {
      if (
        !sessionAgentId ||
        !sessionId ||
        lifecycleRunId !== runId ||
        entry.execution.restartRecovery ||
        !params.gatewayRuntime
      ) {
        return false;
      }
      return Boolean(
        physicalStorePath &&
        findRequesterSettleWakeRecoveryBatch({
          runId,
          requesterSessionKey: childSessionKey,
          requesterAgentId: sessionAgentId,
          sessionId,
          lifecycleRevision,
          storePath: physicalStorePath,
          gatewayRuntime: params.gatewayRuntime,
        }),
      );
    };
    if (!replayTerminal && hasPendingRequesterSettleWake()) {
      return { status: "handled" };
    }
    if (session && !legacy && !replayTerminal) {
      session = await markSubagentRecoverySessionInterrupted({
        entry,
        session,
        isOwnerCurrent: () => isCurrent() && !hasPendingRequesterSettleWake(),
      });
      if (!session || !isCurrent()) {
        return { status: "deferred" };
      }
    }
    const sessionEntry = session?.sessionEntry;
    const currentRead = session?.currentRead;
    const storePath = session?.storePath;
    const matches = (current: SessionEntryCurrentFacts | undefined) =>
      current?.sessionId === sessionId &&
      current?.lifecycleRevision === lifecycleRevision &&
      current?.lifecycleRunId === lifecycleRunId &&
      (!replayTerminal || (current !== undefined && ownsSubagentSessionExecution(entry, current)));
    const assertLive = () => {
      if (
        !currentRead ||
        !storePath ||
        !isGatewayCurrent() ||
        listAgentRunsForSession(target).length !== 0 ||
        isSessionControllerWorkActive(storePath, [childSessionKey, sessionId])
      ) {
        throw new Error("Subagent child session effects owner changed");
      }
      return currentRead;
    };
    const assertCurrentEntry = (current: SessionEntryCurrentFacts | undefined) => {
      assertLive();
      if (!matches(current)) {
        throw new Error("Subagent child session generation changed");
      }
    };
    const sessionEffects: SubagentSessionEffects = {
      async isCurrent() {
        try {
          const reader = assertLive();
          const current = await reader.readCurrent();
          assertCurrentEntry(current);
          return true;
        } catch {
          return false;
        }
      },
      assertHostCurrent() {
        const reader = assertLive();
        reader.assertSourceCurrent();
        if (!reader.source) {
          assertCurrentEntry(reader.readCurrent());
        }
      },
      assertCurrentEntry,
      ...(currentRead?.source
        ? {
            nativeCheck: {
              source: currentRead.source,
              assertCurrent(current: SessionEntryCurrentFacts | undefined) {
                currentRead.assertSourceCurrent();
                assertCurrentEntry(current);
              },
            },
          }
        : {}),
    };
    if (!legacy && !replayTerminal && !(await sessionEffects.isCurrent())) {
      return { status: "handled" };
    }
    if (!isCurrent()) {
      return { status: "deferred" };
    }
    if (
      !replayTerminal &&
      sessionEntry?.lifecycleRunId &&
      (legacy
        ? sessionEntry.lifecycleRunId === runId
        : ownsSubagentSessionExecution(entry, sessionEntry)) &&
      resolveCompletionFromSessionEntry(sessionEntry, Date.now(), {
        notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
      })
    ) {
      return { status: "ignored" };
    }
    const receipt = entry.execution.restartRecovery;
    if (
      !legacy &&
      !replayTerminal &&
      !receipt &&
      sessionEntry?.abortedLastRun !== true &&
      entry.execution.status !== "interrupted"
    ) {
      return { status: "ignored" };
    }
    // Old launch receipts are evidence of uncertain effects, never permission
    // to replay a child. The requester decides whether to continue its history.
    const suppressSessionEffects =
      legacy ||
      currentRead?.kind === "missing" ||
      (receipt !== undefined && !isRestartRecoveryLifecycleCurrent(receipt)) ||
      (sessionEntry?.lifecycleRunId !== undefined &&
        !ownsSubagentSessionExecution(entry, sessionEntry));
    const isRecoveryHostCurrent = () => {
      if (!isCurrent() || (!replayTerminal && hasPendingRequesterSettleWake())) {
        return false;
      }
      if (!legacy && !replayTerminal) {
        try {
          sessionEffects.assertHostCurrent();
        } catch {
          return false;
        }
      }
      return true;
    };
    return {
      status: "terminal",
      recoveryCurrent: {
        isHostCurrent: isRecoveryHostCurrent,
        prepare: async () =>
          isRecoveryHostCurrent() &&
          (legacy || replayTerminal || (await sessionEffects.isCurrent())) &&
          isRecoveryHostCurrent(),
        onPublished: (published) => {
          expectedObservation = published;
        },
      },
      sessionEffects: legacy ? undefined : sessionEffects,
      error:
        terminalError ??
        "Subagent execution was interrupted by a Gateway restart. " +
          "Inspect retained session history and uncertain tool outcomes, then continue the child " +
          "with a follow-up or assign replacement work.",
      endedAt: replayTerminal ? entry.execution.endedAt : undefined,
      suppressSessionEffects: suppressSessionEffects || undefined,
    };
  } catch (error) {
    params.warn("failed to reconcile interrupted subagent execution", {
      runId,
      childSessionKey,
      error,
    });
    return { status: "deferred" };
  }
}
