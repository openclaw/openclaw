import { getSubagentSweepRuns } from "./subagent-registry-memory.js";
import { isSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import { isSubagentKeepRunArchiveDue } from "./subagent-registry-work-index.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function orderSubagentSweepEntries(runs: Map<string, SubagentRunRecord>, now: number) {
  const phases: Array<Array<[string, SubagentRunRecord]>> = Array.from({ length: 3 }, () => []);
  for (const entry of getSubagentSweepRuns(runs, now)) {
    // The bounded archival pass owns settled history; it owes no lifecycle sweep.
    if (isSubagentKeepRunArchiveDue(entry, now)) {
      continue;
    }
    const runId = entry.runId;
    const phase = isSuspendedPendingFinalDelivery(entry) ? 0 : entry.killReconciliation ? 1 : 2;
    phases[phase]!.push([runId, entry]);
  }
  return phases.flat();
}
