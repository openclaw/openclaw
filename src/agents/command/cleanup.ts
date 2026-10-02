import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import { clearCommandRecoveryClaim } from "./post-run.js";
import type { AgentCommandOpts } from "./types.js";

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
