/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 *
 * Continuation (karmaterminal/openclaw#1544): also every session that holds live continuation
 * custody, which entry-cap eviction, age pruning and disk-budget cleanup then never select. A deleted
 * session loses the elections it owns ("source session owner is unavailable"), and the returns owed
 * to it are refused, because its recipient authority advanced. A session holds custody while it owns
 * a live election (`hasLiveContinuationCustody`'s rule), while an admitted continuation child still
 * owes it a return, or while a pending continuation row is addressed to it. Once that settles, the
 * next pass may evict it as before. Named limit: a store full of live custody stays above
 * `maxEntries` until custody ends. Accepted edge: owners and rows are read once while a pass
 * prepares; custody that begins after that read, on a session nothing else protects when the pass
 * captures its protection, waits for the next pass.
 */
import { listLiveContinuationCustodyOwners } from "../../../auto-reply/continuation/work-store.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { listPendingContinuationSessionDeliveryKeys } from "../../../infra/session-delivery-queue-storage.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { prepareSubagentMaintenanceRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function* protectedSubagentSessionKeys(
  runs: Iterable<SubagentRunMaintenanceRecord>,
  custodyHolders: readonly string[],
) {
  for (const entry of runs) {
    yield entry.childSessionKey;
    // An admitted continuation child owes its return to its requester and its bound recipients.
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
  const [prepared, owners, recipients] = await Promise.all([
    prepareSubagentMaintenanceRunsSnapshotForRead(
      subagentRuns,
      native ? { live: true } : undefined,
    ),
    listLiveContinuationCustodyOwners(),
    listPendingContinuationSessionDeliveryKeys(captureOpenClawStateWorkerContext()),
  ]);
  const custodyHolders = [...owners, ...recipients];
  return {
    capture: () => protectedSubagentSessionKeys(prepared.capture(), custodyHolders),
    dispose() {},
  };
});
