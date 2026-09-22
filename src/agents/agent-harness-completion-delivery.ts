import { isDeepStrictEqual } from "node:util";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-types.js";
import {
  loadExactSessionEntry,
  readSessionSubmittedInput,
} from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  getAgentRunLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getOwedHarnessCompletionTask,
  readAdmittedHarnessCompletionInput,
  settleHarnessCompletionTask,
} from "../tasks/agent-harness-completion-recovery.js";
import { getTaskByIdForOwner } from "../tasks/task-owner-access.js";
import { listTaskRecords } from "../tasks/task-registry-query.js";
import { resolveTaskSessionAgentId } from "../tasks/task-session-identity.js";

const log = createSubsystemLogger("agents/harness-completion-recovery");

/** These receipts are stricter than legacy live-return classification: omission is not success. */
function hasHarnessCompletionFinalReceipt(
  receipt: RestartRecoveryTerminalDeliveryEvidence,
): boolean {
  const target = receipt.deliveryContext;
  if (
    !target?.channel ||
    !target.to ||
    receipt.payloadsTruncated ||
    receipt.messagingToolSentTargetsTruncated ||
    receipt.messagingToolAggregateEvidenceUnaccounted
  ) {
    return false;
  }
  const requiredProvider = normalizeOptionalString(target.channel)?.toLowerCase();
  if (!requiredProvider) {
    return false;
  }
  if (
    receipt.messagingToolSentTargets?.some(
      (sent) =>
        normalizeOptionalString(sent.provider)?.toLowerCase() === requiredProvider &&
        normalizeOptionalString(sent.accountId) === normalizeOptionalString(target.accountId) &&
        sent.sourceReplyFinal === true &&
        sent.visible === true &&
        sourceDeliveryTargetsMatch(sent, target),
    )
  ) {
    return true;
  }
  return (
    receipt.deliveryStatus?.status === "sent" &&
    (receipt.deliveryStatus.resultCount ?? 0) > 0 &&
    receipt.payloads?.some((payload) => payload.visible === true) === true
  );
}

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
    taskRunId: string;
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
    claim.taskRunId !== params.taskRunId ||
    claim.requesterAgentId !== params.agentId ||
    claim.requesterSessionKey !== params.sessionKey ||
    !sameRequester(claim, entry)
  ) {
    return "blocked";
  }
  const task = getTaskByIdForOwner({
    taskId: claim.taskId,
    callerOwnerKey: claim.requesterSessionKey,
    callerAgentId: claim.requesterAgentId,
  });
  if (
    !task ||
    task.runId !== claim.taskRunId ||
    task.requesterSessionKey !== claim.requesterSessionKey
  ) {
    return "blocked";
  }
  if (task.deliveryStatus === "delivered") {
    return "delivered";
  }
  if (!getOwedHarnessCompletionTask(claim, entry)) {
    return "blocked";
  }
  if (
    isDeepStrictEqual(receipt?.harnessCompletion, claim) &&
    receipt !== undefined &&
    hasHarnessCompletionFinalReceipt(receipt)
  ) {
    const settled = settleHarnessCompletionTask({
      claim,
      readCurrentSession: () => readCurrent(params),
      hasQualifyingReceipt(current) {
        const actual = getRestartRecoveryTerminalDeliveryEvidence(current, claim.sourceRunId);
        return (
          isDeepStrictEqual(actual?.harnessCompletion, claim) &&
          actual !== undefined &&
          hasHarnessCompletionFinalReceipt(actual)
        );
      },
    });
    return settled ? "delivered" : "blocked";
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

/** Startup and command cleanup settle retained receipts even if no native monitor survives. No model/send. */
export function reconcileRetainedHarnessCompletionDeliveries(): void {
  const cfg = getRuntimeConfig();
  const scopes = new Map<string, CompletionTarget>();
  for (const task of listTaskRecords()) {
    if (task.runtime !== "subagent" || !task.taskKind || task.deliveryStatus !== "pending") {
      continue;
    }
    const agentId = resolveTaskSessionAgentId(task.requesterSessionKey, task.requesterAgentId, cfg);
    if (!agentId) {
      continue;
    }
    const target = {
      agentId,
      sessionKey: task.requesterSessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    };
    scopes.set(`${agentId}\n${target.sessionKey}`, target);
  }
  for (const target of scopes.values()) {
    try {
      reconcileSessionHarnessCompletionDeliveries(target);
    } catch (error) {
      // A removed or temporarily unreadable requester is not execution authority.
      // Keep its task pending without blocking unrelated Gateway startup work.
      log.warn(`Could not reconcile harness completion for ${target.sessionKey}: ${String(error)}`);
    }
  }
}

export function reconcileSessionHarnessCompletionDeliveries(target: CompletionTarget): void {
  const entry = readCurrent(target);
  for (const receipt of entry?.restartRecoveryTerminalDeliveryEvidence ?? []) {
    if (receipt.harnessCompletion) {
      reconcileHarnessCompletionDelivery({
        ...target,
        sourceRunId: receipt.runId,
        taskRunId: receipt.harnessCompletion.taskRunId,
      });
    }
  }
}
