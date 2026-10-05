import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import { shouldPersistRestartRecoveryCleanup } from "../agent-command-restart-recovery.js";
import { buildMainSessionRecoveryClearPatch } from "../main-session-recovery/main-session-recovery-clear.js";
import { inspectRecoveryLifecycleEvent } from "../main-session-recovery/main-session-recovery-lifecycle.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

export async function clearCommandRecoveryClaim(params: {
  prepared: Pick<
    PreparedAgentCommandExecution,
    "sessionStore" | "sessionKey" | "storePath" | "runId" | "sessionAgentId"
  >;
  sessionEntry?: SessionEntry;
  runOwnedSessionId: string;
  sessionReboundDuringRun: boolean;
  trackedRestartRecoveryDeliveryClaim: boolean;
  terminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidenceResult;
  terminalEvent: Parameters<typeof inspectRecoveryLifecycleEvent>[0]["event"];
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionStore, sessionKey, storePath, runId } = params.prepared;
  const interruptedForRestart = () =>
    inspectRecoveryLifecycleEvent({ event: params.terminalEvent, abortSignal: params.abortSignal })
      .interrupted;
  if (
    params.sessionReboundDuringRun ||
    !params.trackedRestartRecoveryDeliveryClaim ||
    !sessionStore ||
    !sessionKey ||
    interruptedForRestart()
  ) {
    return;
  }
  try {
    const entry = sessionStore[sessionKey] ?? params.sessionEntry;
    if (entry?.restartRecoveryDeliveryRunId === runId) {
      await persistAgentSession({
        agentId: params.prepared.sessionAgentId,
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: entry,
        entry: {
          ...entry,
          ...buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: true,
            terminalRunId: runId,
            terminalDeliveryEvidence: params.terminalDeliveryEvidence,
          }),
          ...buildMainSessionRecoveryClearPatch(entry),
          updatedAt: Date.now(),
        },
        assertCommitAllowed: () => {
          if (interruptedForRestart()) {
            throw createAgentRunRestartAbortError();
          }
        },
        shouldPersist: (current) =>
          !interruptedForRestart() &&
          shouldPersistRestartRecoveryCleanup(current, params.runOwnedSessionId, runId),
      });
    }
  } catch (error) {
    log.warn(
      `failed to clear restart recovery delivery context for ${sessionKey}: ${coerceErrorMessage(error)}`,
    );
  }
}

/** Finishes durable cleanup before releasing the command's transient run owners. */
export async function finishAgentCommandCleanup(
  params: Parameters<typeof clearCommandRecoveryClaim>[0] & {
    lifecycleGeneration: string;
    beforeTerminalDelivery: AgentCommandOpts["beforeTerminalDelivery"];
    reportCommitted: () => void;
    preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
    sessionWorkAdmission: SessionWorkAdmissionLease | undefined;
    cleanupInternalModelRunTargets: () => Promise<void>;
    releaseForeground: (() => void) | undefined;
  },
): Promise<void> {
  try {
    params.reportCommitted();
    await params.preparedRunAdmission?.finish();
    params.sessionWorkAdmission?.release();
    await params.cleanupInternalModelRunTargets();
    await clearCommandRecoveryClaim(params);
  } finally {
    try {
      await params.beforeTerminalDelivery?.();
    } finally {
      clearAgentRunContext(params.prepared.runId, params.lifecycleGeneration);
      params.sessionWorkAdmission?.release();
      params.releaseForeground?.();
    }
  }
}
