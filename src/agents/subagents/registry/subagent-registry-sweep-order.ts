import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export function orderSubagentSweepEntries(runs: Map<string, SubagentRunRecord>, now: number) {
  const phases: Array<Array<[string, SubagentRunRecord]>> = Array.from({ length: 6 }, () => []);
  for (const item of runs) {
    const [runId, entry] = item;
    const phase = isSuspendedPendingFinalDelivery(entry)
      ? 0
      : entry.terminalOwner === "interrupted-recovery"
        ? 1
        : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
          ? isStaleUnendedSubagentRun(entry, now)
            ? 2
            : 3
          : entry.killReconciliation
            ? 4
            : 5;
    phases[phase]!.push(item);
  }
  return phases.flat();
}
