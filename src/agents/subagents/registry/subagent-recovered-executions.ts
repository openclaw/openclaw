import type { SessionRestartRecoveryState } from "../../../config/sessions/restart-recovery-types.js";

/** Recovery changes execution IDs without changing the registered wake's parent obligation. */
export function resolveRecoveredSubagentExecutions(
  session: SessionRestartRecoveryState,
): Map<string, string> {
  const sources = new Map<string, string>();
  for (const receipt of session.restartRecoveryTerminalDeliveryEvidence ?? []) {
    if (receipt.transcriptRunId) {
      sources.set(receipt.transcriptRunId, receipt.runId);
    }
  }
  if (session.restartRecoveryDeliveryRunId) {
    // The current claim takes precedence over historical receipts, including a missing source.
    sources.delete(session.restartRecoveryDeliveryRunId);
    if (session.restartRecoveryDeliverySourceRunId) {
      sources.set(session.restartRecoveryDeliveryRunId, session.restartRecoveryDeliverySourceRunId);
    }
  }
  return sources;
}
