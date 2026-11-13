import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import type { AgentCommandOpts } from "./types.js";

/** Finish accepted persistence before releasing the command's transient owners. */
export async function finishAgentCommandCleanup(params: {
  prepared: Pick<PreparedAgentCommandExecution, "runId">;
  terminalError?: unknown;
  lifecycleGeneration: string;
  beforeTerminalDelivery: AgentCommandOpts["beforeTerminalDelivery"];
  reportCommitted: () => void;
  preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
  sessionWorkAdmission: SessionEffectRef | undefined;
  cleanupInternalModelRunTargets: () => Promise<void>;
  releaseForeground: (() => void) | undefined;
}): Promise<void> {
  try {
    params.reportCommitted();
    await params.preparedRunAdmission?.finish();
    params.sessionWorkAdmission?.release();
    await params.cleanupInternalModelRunTargets();
  } finally {
    try {
      await params.beforeTerminalDelivery?.(undefined, params.terminalError);
    } finally {
      clearAgentRunContext(params.prepared.runId, params.lifecycleGeneration);
      params.sessionWorkAdmission?.release();
      params.releaseForeground?.();
    }
  }
}
