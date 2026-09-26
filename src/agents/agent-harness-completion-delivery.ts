import { isDeepStrictEqual } from "node:util";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import {
  loadExactSessionEntry,
  readSessionSubmittedInput,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
} from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getOwedHarnessCompletionTask,
  hasHarnessCompletionFinalReceipt,
  readAdmittedHarnessCompletionInput,
} from "./agent-harness-completion-recovery.js";

const log = createSubsystemLogger("agents/harness-completion-recovery");

function sameRequester(claim: HarnessCompletionRecovery, entry: SessionEntry): boolean {
  return claim.sessionId === entry.sessionId && claim.lifecycleRevision === entry.lifecycleRevision;
}

type CompletionTarget = { agentId: string; sessionKey: string; storePath: string };
function readCurrent(target: CompletionTarget): SessionEntry | undefined {
  const loaded = loadExactSessionEntry({ ...target, readConsistency: "latest" });
  return loaded?.sessionKey === target.sessionKey ? loaded.entry : undefined;
}

/** Only current process owners can hold admission before its input is committed. */
function hasLiveCompletionOwner(claim: HarnessCompletionRecovery, runId: string): boolean {
  const scope = getPluginRuntimeGatewayRequestScope();
  const gateway = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  const admission = gateway?.chatAbortControllers.get(runId);
  if (
    admission &&
    admission.sessionKey === claim.requesterSessionKey &&
    admission.sessionId === claim.sessionId &&
    admission.agentId === claim.requesterAgentId &&
    admission.lifecycleGeneration === getAgentRunLifecycleGeneration() &&
    admission.projectSessionActive === true &&
    !admission.registrationCleanupRequested &&
    !admission.controller.signal.aborted &&
    isFutureDateTimestampMs(admission.expiresAtMs)
  ) {
    return true;
  }
  const context = getAgentRunContext(runId);
  return (
    hasAgentRunContextExecutionOwner(runId) &&
    context?.sessionKey === claim.requesterSessionKey &&
    context.sessionId === claim.sessionId &&
    context.agentId === claim.requesterAgentId
  );
}

/** Reconcile before any steer/direct path, including when a restored native parent has no live owner. */
export function reconcileHarnessCompletionDelivery(
  params: CompletionTarget & {
    sourceRunId: string;
    taskRunId?: string;
  },
): "unowned" | "pending" | "delivered" | "blocked" {
  const entry = readCurrent(params);
  if (!entry) {
    // No saved claim means this reconciler owns nothing; normal admission still
    // applies its existing requester lifecycle checks.
    return "unowned";
  }
  const receipt = getRestartRecoveryTerminalDeliveryEvidence(entry, params.sourceRunId);
  const claim =
    entry.restartRecoveryHarnessCompletion?.sourceRunId === params.sourceRunId
      ? entry.restartRecoveryHarnessCompletion
      : receipt?.harnessCompletion;
  if (!claim) {
    // Missing metadata is not fresh admission authority. An older writer or
    // bounded receipt eviction can leave the original consumed input intact.
    return entry.restartRecoveryDeliverySourceRunId === params.sourceRunId ||
      hasRestartRecoveryTerminalRun(entry, params.sourceRunId) ||
      readSessionSubmittedInput(
        { ...params, sessionId: entry.sessionId },
        `${params.sourceRunId}:user`,
      )
      ? "blocked"
      : "unowned";
  }
  if (
    claim.sourceRunId !== params.sourceRunId ||
    (params.taskRunId !== undefined && claim.taskRunId !== params.taskRunId) ||
    claim.requesterAgentId !== params.agentId ||
    claim.requesterSessionKey !== params.sessionKey ||
    !sameRequester(claim, entry)
  ) {
    return "blocked";
  }
  if (
    isDeepStrictEqual(receipt?.harnessCompletion, claim) &&
    receipt !== undefined &&
    hasHarnessCompletionFinalReceipt(receipt)
  ) {
    return "delivered";
  }
  if (!getOwedHarnessCompletionTask(claim, entry)) {
    return "blocked";
  }
  if (
    entry.status !== "running" ||
    entry.mainRestartRecovery?.tombstone ||
    entry.restartRecoveryDeliverySourceRunId !== claim.sourceRunId ||
    entry.restartRecoveryHarnessCompletion?.taskId !== claim.taskId
  ) {
    return "blocked";
  }
  const operationalRunId = entry.restartRecoveryDeliveryRunId;
  // A retired scoped resolver can throw. It owns no live custody and must not
  // consume retries merely because an old native monitor still references it.
  try {
    if (operationalRunId && hasLiveCompletionOwner(claim, operationalRunId)) {
      return "pending";
    }
    // Cold custody is pending only while its exact admitted input remains executable.
    // Missing/rejected input retains the durable task, not an uncharged process retry.
    return readAdmittedHarnessCompletionInput({
      claim,
      entry,
      storePath: params.storePath,
      operationalRunId,
    })
      ? "pending"
      : "blocked";
  } catch (error) {
    log.warn(
      `Could not inspect harness completion custody for ${params.sessionKey}: ${String(error)}`,
    );
    return "blocked";
  }
}
