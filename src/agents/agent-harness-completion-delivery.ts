import { isDeepStrictEqual } from "node:util";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import { readSessionSubmittedInput } from "../config/sessions/session-accessor.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
} from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceProjectSessionActive,
  isRpcSourceQueued,
} from "../sessions/session-controller.rpc-sources.js";
import { isCurrentSessionControllerOperation } from "../sessions/session-controller.state.js";
import { rethrowIncognitoSessionError } from "../state/incognito-session-error.js";
import {
  getOwedHarnessCompletionTask,
  hasHarnessCompletionFinalReceipt,
  readAdmittedHarnessCompletionInputAsync,
} from "./agent-harness-completion-recovery.js";

const log = createSubsystemLogger("agents/harness-completion-recovery");

function sameRequester(claim: HarnessCompletionRecovery, entry: SessionEntry): boolean {
  return claim.sessionId === entry.sessionId && claim.lifecycleRevision === entry.lifecycleRevision;
}

type CompletionTarget = { agentId: string; sessionKey: string; storePath: string };
async function readCurrent(target: CompletionTarget): Promise<SessionEntry | undefined> {
  const loaded = await readSessionEntriesFromStoreInWorker({
    ...target,
    sessionKeys: [target.sessionKey],
  });
  return loaded.entries.find(({ sessionKey }) => sessionKey === target.sessionKey)?.entry;
}

/** Only current process owners can hold admission before its input is committed. */
function hasLiveCompletionOwner(claim: HarnessCompletionRecovery, runId: string): boolean {
  const scope = getPluginRuntimeGatewayRequestScope();
  const gateway = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  const admission = gateway
    ? getRpcSourceForGateway(runId, scope?.resolveGatewayContext)
    : undefined;
  const input = admission?.input;
  const sourceClaim = input?.claim;
  const operation = sourceClaim?.operation;
  const claimed =
    input &&
    sourceClaim &&
    input.mailbox.claim === sourceClaim &&
    !sourceClaim.released &&
    !sourceClaim.releaseRequested &&
    !sourceClaim.abortController.signal.aborted &&
    (!operation ||
      (isCurrentSessionControllerOperation(operation) &&
        !operation.result &&
        !operation.abortSignal.aborted));
  if (
    admission &&
    getRpcSourceIdentity(admission).sessionKey === claim.requesterSessionKey &&
    getRpcSourceIdentity(admission).sessionId === claim.sessionId &&
    getRpcSourceIdentity(admission).agentId === claim.requesterAgentId &&
    getRpcSourceLifecycleGeneration(admission) === getAgentRunLifecycleGeneration() &&
    admission.adapter.controlUiVisible !== false &&
    getRpcSourceProjectSessionActive(admission) !== false &&
    !admission.input.retirementRequested &&
    !admission.input.abortSignal.aborted &&
    !admission.input.custody.cancellationRetired &&
    (isRpcSourceQueued(admission) || claimed)
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

function classifyCompletionClaim(
  params: CompletionTarget & { sourceRunId: string; taskRunId?: string },
  entry: SessionEntry,
  claim: HarnessCompletionRecovery,
): "delivered" | "blocked" | undefined {
  if (
    claim.sourceRunId !== params.sourceRunId ||
    (params.taskRunId !== undefined && claim.taskRunId !== params.taskRunId) ||
    claim.requesterAgentId !== params.agentId ||
    claim.requesterSessionKey !== params.sessionKey ||
    !sameRequester(claim, entry)
  ) {
    return "blocked";
  }
  const receipt = getRestartRecoveryTerminalDeliveryEvidence(entry, params.sourceRunId);
  if (
    isDeepStrictEqual(receipt?.harnessCompletion, claim) &&
    receipt !== undefined &&
    hasHarnessCompletionFinalReceipt(receipt)
  ) {
    return "delivered";
  }
  if (
    !getOwedHarnessCompletionTask(claim, entry) ||
    entry.mainRestartRecovery?.tombstone ||
    entry.restartRecoveryDeliverySourceRunId !== claim.sourceRunId ||
    entry.restartRecoveryHarnessCompletion?.taskId !== claim.taskId
  ) {
    return "blocked";
  }
  return undefined;
}

/** Reconcile before any steer/direct path, including when a restored native parent has no live owner. */
export async function reconcileHarnessCompletionDelivery(
  params: CompletionTarget & {
    sourceRunId: string;
    taskRunId?: string;
  },
): Promise<"unowned" | "pending" | "delivered" | "blocked"> {
  const memory = captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} });
  if (memory) {
    return (
      (await withSessionActorStorage(
        params,
        {
          lifetime: { assertCurrent() {}, assertReadable() {} },
          authority: memory.authority,
        },
        (binding) => reconcileMemoryHarnessCompletionDelivery(params, binding),
      )) ?? "unowned"
    );
  }
  return reconcileCurrentHarnessCompletionDelivery(params);
}

function reconcileMemoryHarnessCompletionDelivery(
  params: CompletionTarget & { sourceRunId: string; taskRunId?: string },
  binding: SessionActorStorageBinding,
): "unowned" | "pending" | "delivered" | "blocked" {
  try {
    const snapshot = binding.actor.storage!.readCurrent(
      {
        type: "session.completion.read",
        input: { sourceRunId: params.sourceRunId, mode: "committed" },
      },
      binding.authority,
    );
    const entry = snapshot.entry;
    if (!entry) {
      return "unowned";
    }
    const receipt = getRestartRecoveryTerminalDeliveryEvidence(entry, params.sourceRunId);
    const claim =
      entry.restartRecoveryHarnessCompletion?.sourceRunId === params.sourceRunId
        ? entry.restartRecoveryHarnessCompletion
        : receipt?.harnessCompletion;
    if (!claim) {
      return entry.restartRecoveryDeliverySourceRunId === params.sourceRunId ||
        hasRestartRecoveryTerminalRun(entry, params.sourceRunId) ||
        snapshot.hasSubmittedInput
        ? "blocked"
        : "unowned";
    }
    const classified = classifyCompletionClaim(params, entry, claim);
    if (classified) {
      return classified;
    }
    const runId = entry.restartRecoveryDeliveryRunId;
    return (runId && hasLiveCompletionOwner(claim, runId)) || snapshot.validInput
      ? "pending"
      : "blocked";
  } catch (error) {
    rethrowIncognitoSessionError(error);
    log.warn(
      `Could not inspect harness completion custody for ${params.sessionKey}: ${String(error)}`,
    );
    return "blocked";
  }
}

async function reconcileCurrentHarnessCompletionDelivery(
  params: CompletionTarget & { sourceRunId: string; taskRunId?: string },
): Promise<"unowned" | "pending" | "delivered" | "blocked"> {
  const entry = await readCurrent(params);
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
    if (
      entry.restartRecoveryDeliverySourceRunId === params.sourceRunId ||
      hasRestartRecoveryTerminalRun(entry, params.sourceRunId)
    ) {
      return "blocked";
    }
    const submitted = await readSessionSubmittedInput(
      { ...params, sessionId: entry.sessionId },
      `${params.sourceRunId}:user`,
    );
    return submitted ? "blocked" : "unowned";
  }
  const classified = classifyCompletionClaim(params, entry, claim);
  if (classified) {
    return classified;
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
    const validInput = await readAdmittedHarnessCompletionInputAsync({
      claim,
      entry,
      storePath: params.storePath,
      operationalRunId,
    });
    return validInput ? "pending" : "blocked";
  } catch (error) {
    rethrowIncognitoSessionError(error);
    log.warn(
      `Could not inspect harness completion custody for ${params.sessionKey}: ${String(error)}`,
    );
    return "blocked";
  }
}
