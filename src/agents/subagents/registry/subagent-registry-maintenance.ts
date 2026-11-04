/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { listContinuationCustodyHolders } from "../../../auto-reply/continuation/custody-holders.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { prepareSubagentMaintenanceRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function* protectedSubagentSessionKeys(
  runs: Iterable<SubagentRunMaintenanceRecord>,
  custodyHolders: readonly string[],
) {
  for (const entry of runs) {
    yield entry.childSessionKey;
    // Continuation custody (karmaterminal/openclaw#1544): an admitted continuation child still
    // owes its return to its requester and to every room its recipient authority is bound to.
    const binding = entry.continuationRecipientAuthorityBinding;
    if (binding) {
      yield entry.requesterSessionKey;
      if (binding.selection === "selected") {
        for (const recipient of binding.recipients) {
          yield recipient.sessionKey;
        }
      }
    }
  }
  yield* custodyHolders;
}

registerSessionMaintenancePreserveKeysProvider(async ({ native }) => {
  const [prepared, custodyHolders] = await Promise.all([
    prepareSubagentMaintenanceRunsSnapshotForRead(
      subagentRuns,
      native ? { live: true } : undefined,
    ),
    listContinuationCustodyHolders(),
  ]);
  return {
    capture: () => protectedSubagentSessionKeys(prepared.capture(), custodyHolders),
    dispose() {},
  };
});
