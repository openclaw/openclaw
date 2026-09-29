import type { SessionEntryCurrentFacts } from "../../../config/sessions/session-entry-current.types.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { isSessionWorkAdmissionActive } from "../../../sessions/session-lifecycle-admission.js";
import {
  getSubagentRunsForRequesterSession,
  getSubagentRunsForChildSession,
} from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import {
  getRestartRecoveryReplayError,
  isRestartRecoveryLifecycleCurrent,
  ownsSubagentSessionExecution,
} from "./subagent-registry-restart-recovery-helpers.js";
import { loadSubagentRecoverySession } from "./subagent-registry-restart-recovery-session.js";
import type {
  RestartRecoveryParams,
  RestartRecoveryResult,
} from "./subagent-registry-restart-recovery-types.js";
import type { SubagentSessionEffects } from "./subagent-registry.types.js";
import { isRequesterSettleWakeForRun } from "./subagent-requester-settle-identity.js";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

export type { RestartRecoveryParams, RestartRecoveryResult };

export async function recoverInterruptedSubagentRow(
  params: RestartRecoveryParams,
): Promise<RestartRecoveryResult> {
  const { entry, runId } = params;
  const childSessionKey = entry.childSessionKey.trim();
  const lifecycleGeneration = agentEvents.getAgentEventLifecycleGeneration();
  const isGatewayCurrent = () =>
    agentEvents.isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
    params.isGatewayCurrent?.() !== false;
  const isCurrent = () =>
    isGatewayCurrent() &&
    params.isCurrent(runId, entry) &&
    entry.pauseReason !== "sessions_yield" &&
    entry.suppressAnnounceReason !== "steer-restart" &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    entry.execution.status !== "queued";
  if (!childSessionKey || !isCurrent()) {
    return { status: "ignored" };
  }
  const terminalError = getRestartRecoveryReplayError(entry);
  const replayTerminal = terminalError !== undefined;
  if (!replayTerminal && typeof entry.execution.endedAt === "number") {
    return { status: "ignored" };
  }
  try {
    const session = await loadSubagentRecoverySession({ entry, isOwnerCurrent: isCurrent }).catch(
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
    const sessionEntry = session?.sessionEntry;
    const sessionId = sessionEntry?.sessionId;
    const lifecycleRevision = sessionEntry?.lifecycleRevision;
    const lifecycleRunId = sessionEntry?.lifecycleRunId;
    const sessionAgentId = session?.agentId;
    const target = { sessionKey: childSessionKey, sessionId };
    // A yielded requester can itself be a subagent. Its incoming frozen batch,
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
      const children = new Map(
        [...getSubagentRunsForRequesterSession(childSessionKey)]
          .filter(
            (child) =>
              getLatestSubagentRunByChildSessionKeyFromRuns(
                getSubagentRunsForChildSession(child.childSessionKey),
                child.childSessionKey,
              ) === child,
          )
          .map((child) => [child.runId, child]),
      );
      return [...children.values()].some((child) => {
        const wake = child.requesterSettleWake;
        return (
          wake?.status === "dispatching" &&
          wake.requesterYieldBatch === true &&
          wake.rearmGeneration !== undefined &&
          isRequesterSettleWakeForRun({
            entry: child,
            runId,
            requesterSessionKey: childSessionKey,
            requesterAgentId: sessionAgentId,
            runsById: children,
          }) &&
          wake.batchRunIds?.every((id) => {
            const member = children.get(id);
            return (
              member?.expectsCompletionMessage === true &&
              !member.collect &&
              member.completionRequesterSessionId === sessionId &&
              member.requesterStorePath === physicalStorePath &&
              member.requesterAgentId === sessionAgentId &&
              !member.suppressCompletionDelivery &&
              !member.killReconciliation?.suppressTaskDelivery &&
              member.requesterSettleWake?.status === "dispatching" &&
              member.requesterSettleWake.rearmGeneration === wake.rearmGeneration &&
              member.requesterSettleWake.attemptCount === wake.attemptCount &&
              getGatewayContextResolver(member)?.()?.recoveryRuntime === params.gatewayRuntime
            );
          })
        );
      });
    };
    if (!replayTerminal && hasPendingRequesterSettleWake()) {
      return { status: "handled" };
    }
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
        isSessionWorkAdmissionActive(storePath, [childSessionKey, sessionId])
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
    if (!replayTerminal && !(await sessionEffects.isCurrent())) {
      return { status: "handled" };
    }
    if (!isCurrent()) {
      return { status: "deferred" };
    }
    if (
      !replayTerminal &&
      sessionEntry?.lifecycleRunId &&
      ownsSubagentSessionExecution(entry, sessionEntry) &&
      resolveCompletionFromSessionEntry(sessionEntry, Date.now(), {
        notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
      })
    ) {
      return { status: "ignored" };
    }
    const receipt = entry.execution.restartRecovery;
    if (
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
      currentRead?.kind === "missing" ||
      (receipt !== undefined && !isRestartRecoveryLifecycleCurrent(receipt)) ||
      (sessionEntry?.lifecycleRunId !== undefined &&
        !ownsSubagentSessionExecution(entry, sessionEntry));
    const resolveGatewayContext = params.gatewayRuntime
      ? getGatewayContextResolver(params.gatewayRuntime)
      : undefined;
    if (resolveGatewayContext) {
      bindGatewayContextResolver(entry, resolveGatewayContext);
    }
    const isRecoveryHostCurrent = () => {
      if (!isCurrent() || (!replayTerminal && hasPendingRequesterSettleWake())) {
        return false;
      }
      if (!replayTerminal) {
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
          (replayTerminal || (await sessionEffects.isCurrent())) &&
          isRecoveryHostCurrent(),
      },
      sessionEffects,
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
