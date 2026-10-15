import { isDeepStrictEqual } from "node:util";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import {
  loadExactSessionEntry,
  readSessionEntriesFromStoreInWorker,
  readSessionSubmittedInput,
} from "../config/sessions/session-accessor.js";
import { readPendingInputSource } from "../config/sessions/session-pending-input-source.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
} from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  getOwedHarnessCompletionTask,
  hasHarnessCompletionFinalReceipt,
} from "./agent-harness-completion-recovery.js";

const log = createSubsystemLogger("agents/harness-completion-recovery");

function sameRequester(claim: HarnessCompletionRecovery, entry: SessionEntry): boolean {
  return claim.sessionId === entry.sessionId && claim.lifecycleRevision === entry.lifecycleRevision;
}

type CompletionTarget = { agentId: string; sessionKey: string; storePath: string };
async function readCurrent(target: CompletionTarget): Promise<SessionEntry | undefined> {
  // Incognito remains owned by its process-held native database until the actor cutover.
  if (isIncognitoSessionKey(target.sessionKey)) {
    return loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
  }
  const loaded = await readSessionEntriesFromStoreInWorker({
    ...target,
    sessionKeys: [target.sessionKey],
  });
  return loaded.entries.find((row) => row.sessionKey === target.sessionKey)?.entry;
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
export async function reconcileHarnessCompletionDelivery(
  params: CompletionTarget & {
    sourceRunId: string;
    taskRunId?: string;
  },
): Promise<"unowned" | "pending" | "delivered" | "blocked"> {
  let entry: SessionEntry | undefined;
  try {
    entry = await readCurrent(params);
  } catch (error) {
    // Until custody is readable, a fresh completion may have no durable input.
    log.warn(
      `Could not inspect harness completion requester for ${params.sessionKey}: ${String(error)}`,
    );
    return "pending";
  }
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
    let submitted: Awaited<ReturnType<typeof readSessionSubmittedInput>>;
    let current: SessionEntry | undefined;
    try {
      submitted = await readSessionSubmittedInput(
        { ...params, sessionId: entry.sessionId },
        `${params.sourceRunId}:user`,
      );
      current = await readCurrent(params);
    } catch (error) {
      log.warn(
        `Could not inspect harness completion admission for ${params.sessionKey}: ${String(error)}`,
      );
      return "pending";
    }
    if (
      !current ||
      current.sessionId !== entry.sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.restartRecoveryDeliverySourceRunId === params.sourceRunId ||
      current.restartRecoveryHarnessCompletion?.sourceRunId === params.sourceRunId ||
      hasRestartRecoveryTerminalRun(current, params.sourceRunId) ||
      getRestartRecoveryTerminalDeliveryEvidence(current, params.sourceRunId)?.harnessCompletion ||
      submitted
    ) {
      return "blocked";
    }
    // Recovery can outlive the original delivery call. Keep a fresh sibling
    // outside admission until that exact live/executable claim releases the
    // requester, rather than staging an input that cannot acquire its claim.
    const other = current.restartRecoveryHarnessCompletion;
    if (
      !other ||
      other.requesterAgentId !== params.agentId ||
      other.requesterSessionKey !== params.sessionKey
    ) {
      return "unowned";
    }
    const custody = await reconcilePendingHarnessCompletion(params, current, other);
    return custody === "released" ? "unowned" : custody;
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
  const custody = await reconcilePendingHarnessCompletion(params, entry, claim);
  return custody === "released" ? "blocked" : custody;
}

async function reconcilePendingHarnessCompletion(
  params: CompletionTarget & { sourceRunId: string },
  entry: SessionEntry,
  claim: HarnessCompletionRecovery,
): Promise<"pending" | "blocked" | "released"> {
  if (!getOwedHarnessCompletionTask(claim, entry)) {
    return "released";
  }
  if (
    entry.status !== "running" ||
    entry.mainRestartRecovery?.tombstone ||
    entry.restartRecoveryDeliverySourceRunId !== claim.sourceRunId ||
    entry.restartRecoveryHarnessCompletion?.taskId !== claim.taskId
  ) {
    return "released";
  }
  const operationalRunId = entry.restartRecoveryDeliveryRunId;
  const isSibling = claim.sourceRunId !== params.sourceRunId;
  // A retired scoped resolver can throw. It owns no live custody and must not
  // consume retries merely because an old native monitor still references it.
  try {
    if (operationalRunId && hasLiveCompletionOwner(claim, operationalRunId)) {
      return "pending";
    }
    // Cold custody is pending only while its exact admitted input remains executable.
    // Missing/rejected input retains the durable task, not an uncharged process retry.
    const recoveryRunIds = (entry.restartRecoveryRuns ?? [])
      .filter((run) => Boolean(run.lifecycleGeneration))
      .map((run) => run.runId);
    const source = await readPendingInputSource(
      { ...params, sessionId: entry.sessionId },
      `${claim.sourceRunId}:user`,
      false,
      {
        claim,
        recoveryRunIds: operationalRunId ? [operationalRunId, ...recoveryRunIds] : recoveryRunIds,
      },
    );
    const current = await readCurrent(params);
    source?.assertCurrent();
    if (!current || !sameRequester(claim, current)) {
      return "blocked";
    }
    if (
      !isDeepStrictEqual(current.restartRecoveryHarnessCompletion, claim) ||
      current.status !== "running" ||
      current.mainRestartRecovery?.tombstone ||
      current.restartRecoveryDeliverySourceRunId !== claim.sourceRunId ||
      current.restartRecoveryDeliveryRunId !== operationalRunId ||
      !isDeepStrictEqual(current.restartRecoveryRuns, entry.restartRecoveryRuns) ||
      !getOwedHarnessCompletionTask(claim, current)
    ) {
      // The sibling has not been admitted yet. Keep its notification for a fresh
      // retry when another completion advances or releases custody during the read.
      return isSibling ? "pending" : "blocked";
    }
    return source?.snapshot.completionExecutable ? "pending" : "released";
  } catch (error) {
    log.warn(
      `Could not inspect harness completion custody for ${params.sessionKey}: ${String(error)}`,
    );
    return isSibling ? "pending" : "blocked";
  }
}
