import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { getSubagentSweepRuns } from "./subagent-registry-memory.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export function orderSubagentSweepEntries(runs: Map<string, SubagentRunRecord>, now: number) {
  const phases: Array<Array<[string, SubagentRunRecord]>> = Array.from({ length: 7 }, () => []);
  for (const entry of getSubagentSweepRuns(runs, now)) {
    const runId = entry.runId;
    const phase = entry.requesterSettleWake
      ? 0
      : isSuspendedPendingFinalDelivery(entry)
        ? 1
        : entry.terminalOwner === "interrupted-recovery"
          ? 2
          : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
            ? isStaleUnendedSubagentRun(entry, now)
              ? 3
              : 4
            : entry.killReconciliation
              ? 5
              : 6;
    phases[phase]!.push([runId, entry]);
  }
  return phases.flat();
}
