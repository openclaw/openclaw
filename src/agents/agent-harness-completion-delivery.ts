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
import { decodeSessionTranscriptWorkerReadError } from "../config/sessions/session-history-worker-errors.js";
import {
  captureIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  hasAgentRunContextExecutionOwner,
} from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { rethrowIncognitoSessionError } from "../state/incognito-session-error.js";
import {
  hasHarnessCompletionFinalReceipt,
  getOwedHarnessCompletionTask,
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

async function readActorCurrent(
  target: CompletionTarget,
  binding: IncognitoSessionBinding,
): Promise<SessionEntry | undefined> {
  const { actor, admissionSignal } = binding;
  const current = await actor.sessions.read(
    { assertCurrent: () => actor.assertReadable() },
    { sessionKey: target.sessionKey },
    admissionSignal,
  );
  return current.entry;
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
  const binding = captureIncognitoSessionBinding(params);
  const claim = binding?.actor.sessions.captureCurrent(params.sessionKey);
  const reconcile = async () => {
    claim?.assertCurrent();
    const result = await reconcileCurrentHarnessCompletionDelivery(params, binding);
    claim?.assertCurrent();
    return result;
  };
  return binding ? binding.actor.sessions.withSharedState(reconcile) : reconcile();
}

async function reconcileCurrentHarnessCompletionDelivery(
  params: CompletionTarget & { sourceRunId: string; taskRunId?: string },
  binding?: IncognitoSessionBinding,
): Promise<"unowned" | "pending" | "delivered" | "blocked"> {
  const entry = binding ? await readActorCurrent(params, binding) : readCurrent(params);
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
    const current = binding ? await readActorCurrent(params, binding) : readCurrent(params);
    return !current ||
      current.sessionId !== entry.sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.restartRecoveryDeliverySourceRunId === params.sourceRunId ||
      current.restartRecoveryHarnessCompletion?.sourceRunId === params.sourceRunId ||
      hasRestartRecoveryTerminalRun(current, params.sourceRunId) ||
      getRestartRecoveryTerminalDeliveryEvidence(current, params.sourceRunId)?.harnessCompletion ||
      submitted
      ? "blocked"
      : "unowned";
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
    if (binding) {
      const snapshot = await binding.actor.sessions.history(
        { assertCurrent: () => binding.actor.assertReadable() },
        {
          type: "session.history.harness-completion-source",
          input: {
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            claim,
            admission: resolveSessionTranscriptReadFence({
              agentId: params.agentId,
              sessionId: entry.sessionId,
            }),
          },
        },
        binding.admissionSignal,
      );
      if (!snapshot.entry) {
        return "blocked";
      }
      // Delivery and claim state may change while this read waits in the actor queue.
      const current = classifyCompletionClaim(params, snapshot.entry, claim);
      if (current) {
        return current;
      }
      const currentRunId = snapshot.entry.restartRecoveryDeliveryRunId;
      if (currentRunId && hasLiveCompletionOwner(claim, currentRunId)) {
        return "pending";
      }
      if (snapshot.readError) {
        throw decodeSessionTranscriptWorkerReadError(snapshot.readError);
      }
      return snapshot.validInput ? "pending" : "blocked";
    }
    const validInput = readAdmittedHarnessCompletionInput({
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
