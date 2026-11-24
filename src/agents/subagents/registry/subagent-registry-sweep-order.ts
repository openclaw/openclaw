import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { getSubagentSweepRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function orderSubagentSweepEntries(runs: Map<string, SubagentRunRecord>, now: number) {
  const phases: Array<Array<[string, SubagentRunRecord]>> = Array.from({ length: 3 }, () => []);
  for (const entry of getSubagentSweepRuns(runs, now)) {
    const runId = entry.runId;
    const phase = isDeliverySuspended(entry) ? 0 : entry.killReconciliation ? 1 : 2;
    phases[phase]!.push([runId, entry]);
  }
  return phases.flat();
}
