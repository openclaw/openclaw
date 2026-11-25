/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { prepareSubagentMaintenanceRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function* protectedSubagentSessionKeys(runs: Iterable<SubagentRunMaintenanceRecord>) {
  for (const entry of runs) {
    yield entry.childSessionKey;
  }
}

registerSessionMaintenancePreserveKeysProvider(async ({ native }) => {
  const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(
    subagentRuns,
    native ? { live: true } : undefined,
  );
  return {
    capture: () => protectedSubagentSessionKeys(prepared.capture()),
    dispose() {},
  };
});
