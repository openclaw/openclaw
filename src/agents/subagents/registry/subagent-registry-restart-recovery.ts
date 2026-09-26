import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { isSessionWorkAdmissionActive } from "../../../sessions/session-lifecycle-admission.js";
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
  const isCurrent = () => isGatewayCurrent() && params.isCurrent(runId, entry);
  if (
    !childSessionKey ||
    !isCurrent() ||
    entry.pauseReason === "sessions_yield" ||
    entry.suppressAnnounceReason === "steer-restart" ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.status === "queued"
  ) {
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
    const sessionEntry = session?.sessionEntry;
    const sessionId = sessionEntry?.sessionId;
    const lifecycleRevision = sessionEntry?.lifecycleRevision;
    const lifecycleRunId = sessionEntry?.lifecycleRunId;
    const target = { sessionKey: childSessionKey, sessionId };
    const isChildSessionEffectsCurrent = () => {
      if (!session || !isGatewayCurrent()) {
        return false;
      }
      try {
        const current = loadSessionEntry({
          storePath: session.storePath,
          sessionKey: childSessionKey,
          clone: false,
        });
        return (
          current?.sessionId === sessionId &&
          current?.lifecycleRevision === lifecycleRevision &&
          current?.lifecycleRunId === lifecycleRunId &&
          (!replayTerminal ||
            (current !== undefined && ownsSubagentSessionExecution(entry, current))) &&
          listAgentRunsForSession(target).length === 0 &&
          !isSessionWorkAdmissionActive(session.storePath, [childSessionKey, sessionId])
        );
      } catch {
        return false;
      }
    };
    if (!replayTerminal && !isChildSessionEffectsCurrent()) {
      return { status: "handled" };
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
      (receipt !== undefined && !isRestartRecoveryLifecycleCurrent(receipt)) ||
      (sessionEntry?.lifecycleRunId !== undefined &&
        !ownsSubagentSessionExecution(entry, sessionEntry));
    const resolveGatewayContext = params.gatewayRuntime
      ? getGatewayContextResolver(params.gatewayRuntime)
      : undefined;
    if (resolveGatewayContext) {
      bindGatewayContextResolver(entry, resolveGatewayContext);
    }
    return {
      status: "terminal",
      isRecoveryCurrent: () => isCurrent() && (replayTerminal || isChildSessionEffectsCurrent()),
      isChildSessionEffectsCurrent,
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
