import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { mergeRestartRecoveryTerminalRunIds } from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../../config/sessions/restart-recovery-types.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { releaseSessionSourceAuthorities } from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import { shouldPersistCurrentRunSessionCleanup } from "../agent-command-restart-recovery.js";
import { buildMainSessionRecoverySettlementPatch } from "../main-session-recovery/main-session-recovery-clear.js";
import { inspectMainSessionRecoveryLifecycleEvent } from "../main-session-recovery/main-session-recovery-lifecycle.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

/** Finishes durable cleanup before releasing the command's transient run owners. */
export async function finishAgentCommandCleanup(params: {
  prepared: Pick<
    PreparedAgentCommandExecution,
    "sessionStore" | "sessionKey" | "storePath" | "runId" | "sessionAgentId"
  >;
  sessionEntry?: SessionEntry;
  runOwnedSessionId: string;
  sessionReboundDuringRun: boolean;
  trackedRestartRecoveryDeliveryClaim: boolean;
  terminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidenceResult;
  terminalEvent: Parameters<typeof inspectMainSessionRecoveryLifecycleEvent>[0]["event"];
  abortSignal?: AbortSignal;
  lifecycleGeneration: string;
  beforeTerminalDelivery: AgentCommandOpts["beforeTerminalDelivery"];
  reportCommitted: () => void;
  preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
  sessionWorkAdmission: SessionWorkAdmissionLease | undefined;
  cleanupInternalModelRunTargets: () => Promise<void>;
  releaseForeground: (() => void) | undefined;
  completionSource?: { release: () => Promise<void> };
}): Promise<void> {
  const errors: unknown[] =
    params.terminalEvent.data?.phase === "error" ? [params.terminalEvent.data.error] : [];
  try {
    try {
      params.reportCommitted();
      // Accepted terminal writes must consume their fences before fallback cleanup.
      await params.preparedRunAdmission?.finish();
      params.sessionWorkAdmission?.release();
      await params.cleanupInternalModelRunTargets();
      const { sessionStore, sessionKey, storePath, runId } = params.prepared;
      const interruptedForRestart = () =>
        inspectMainSessionRecoveryLifecycleEvent({
          currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
          event: params.terminalEvent,
          abortSignal: params.abortSignal,
        }).interrupted;
      if (
        params.sessionReboundDuringRun ||
        !sessionStore ||
        !sessionKey ||
        interruptedForRestart()
      ) {
        return;
      }
      try {
        const entry = sessionStore[sessionKey] ?? params.sessionEntry;
        const ownsDeliveryClaim = (current: SessionEntry) =>
          params.trackedRestartRecoveryDeliveryClaim &&
          current.restartRecoveryDeliveryRunId === runId;
        const isExecutionFence = (run: NonNullable<SessionEntry["restartRecoveryRuns"]>[number]) =>
          run.runId === runId && run.lifecycleGeneration === params.lifecycleGeneration;
        if (
          !entry ||
          (!ownsDeliveryClaim(entry) && !entry.restartRecoveryRuns?.some(isExecutionFence))
        ) {
          return;
        }
        const persisted = await patchSessionEntryCore(
          { agentId: params.prepared.sessionAgentId, sessionKey, storePath },
          (current) => {
            if (!shouldPersistCurrentRunSessionCleanup(current, params.runOwnedSessionId, runId)) {
              return null;
            }
            if (ownsDeliveryClaim(current)) {
              return {
                ...current,
                ...buildMainSessionRecoverySettlementPatch({
                  entry: current,
                  recordTerminalSource: true,
                  clearRecoveryState: current.abortedLastRun !== true,
                  terminalRunId: runId,
                  terminalDeliveryEvidence: params.terminalDeliveryEvidence,
                }),
                updatedAt: Date.now(),
              };
            }
            const remaining = current.restartRecoveryRuns?.filter((run) => !isExecutionFence(run));
            if (!remaining || remaining.length === current.restartRecoveryRuns?.length) {
              return null;
            }
            return {
              ...current,
              restartRecoveryRuns: remaining.length ? remaining : undefined,
              ...(!remaining.some((run) => run.runId === runId)
                ? {
                    restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
                      current.restartRecoveryTerminalRunIds,
                      [runId],
                    ),
                  }
                : {}),
              updatedAt: Date.now(),
            };
          },
          {
            replaceEntry: true,
            workerGuard: {
              assertCurrent: () => {
                assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
                if (interruptedForRestart()) {
                  throw createAgentRunRestartAbortError();
                }
              },
            },
          },
        );
        if (persisted) {
          sessionStore[sessionKey] = persisted;
        } else {
          delete sessionStore[sessionKey];
        }
      } catch (error) {
        log.warn(
          `failed to settle restart recovery for ${sessionKey}: ${coerceErrorMessage(error)}`,
        );
      }
    } finally {
      try {
        await params.beforeTerminalDelivery?.(undefined, params.terminalEvent.data?.error);
      } finally {
        clearAgentRunContext(params.prepared.runId, params.lifecycleGeneration);
        params.sessionWorkAdmission?.release();
        params.releaseForeground?.();
      }
    }
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    if (params.completionSource) {
      await releaseSessionSourceAuthorities([params.completionSource], errors);
    }
  }
}
