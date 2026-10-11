import { normalizeStoreSessionKey } from "../../../config/sessions/store-entry.js";
/**
 * Session-store maintenance protection for subagent runs.
 * Preserves child session keys while runs are active, pending delivery, or
 * awaiting completion announces so pruning cannot delete needed transcripts.
 */
import { registerSessionMaintenancePreserveKeysProvider } from "../../../config/sessions/store-maintenance-preserve.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { shouldReadPersistedSubagentRuns } from "./subagent-registry-read-cache.js";
import { prepareSubagentMaintenanceRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunMaintenanceRecord } from "./subagent-registry.types.js";

function shouldPreserveForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  if (entry.killReconciliation || entry.killIntent) {
    // The killed row is a reconciliation tombstone. Its session owns the
    // provider result until the sweeper accepts completion or finalizes cancellation.
    return true;
  }
  if (typeof entry.cleanupCompletedAt === "number") {
    return false;
  }
  return (
    typeof entry.execution.endedAt !== "number" ||
    (entry.expectsCompletionMessage === true && entry.delivery?.status !== "delivered") ||
    entry.delivery?.status === "pending" ||
    isDeliverySuspended(entry)
  );
}

function protectedSubagentSessionKeys(runs: Iterable<SubagentRunMaintenanceRecord>): string[] {
  const keys = new Set<string>();
  for (const entry of runs) {
    if (!shouldPreserveForMaintenance(entry)) {
      continue;
    }
    const childSessionKey = entry.childSessionKey.trim();
    if (childSessionKey) {
      keys.add(childSessionKey);
    }
  }
  return [...keys];
}

registerSessionMaintenancePreserveKeysProvider(async ({ native }) => {
  const context =
    native && shouldReadPersistedSubagentRuns() ? captureOpenClawStateWorkerContext() : undefined;
  const originalIdentity = context && { ...context.admission.identity };
  const current = context
    ? await import("../../../state/openclaw-state-db-current-reader.js").then(
        ({ prepareOpenClawStateCurrentReader }) => prepareOpenClawStateCurrentReader(context),
      )
    : undefined;
  try {
    let readCandidates:
      | typeof import("./subagent-registry.store.sqlite.js").loadSubagentMaintenanceCandidatesInDatabase
      | undefined;
    if (current) {
      const { loadSubagentMaintenanceCandidatesInDatabase } =
        await import("./subagent-registry.store.sqlite.js");
      readCandidates = loadSubagentMaintenanceCandidatesInDatabase;
    }
    // The owning writer publishes revisions across the asynchronous snapshot interval.
    const version = current?.writeRevision();
    const prepared = await prepareSubagentMaintenanceRunsSnapshotForRead(
      subagentRuns,
      native ? { live: true } : undefined,
    );
    return {
      capture: () => protectedSubagentSessionKeys(prepared.capture().values()),
      refreshCandidates(sessionKeys: readonly string[]) {
        const runs = prepared.capture();
        const keys = protectedSubagentSessionKeys(runs.values());
        if (!context || !originalIdentity) {
          return keys;
        }
        context.admission.assertCurrent();
        if (!current) {
          const identity = readDatabasePathIdentitySync(context.admission.databasePath);
          if (
            identity.key !== originalIdentity.key ||
            identity.birthtime !== originalIdentity.birthtime
          ) {
            throw new Error("Session subagent source changed before commit");
          }
        }
        const observed = current?.writeRevision();
        if (current && readCandidates && (observed === undefined || observed !== version)) {
          const candidates = new Set(sessionKeys.map(normalizeStoreSessionKey));
          // Existing legacy spellings use the same normalized session owner.
          const indexedKeys = new Set(sessionKeys);
          for (const run of runs.values()) {
            if (candidates.has(normalizeStoreSessionKey(run.childSessionKey))) {
              indexedKeys.add(run.childSessionKey);
            }
          }
          const refreshed = current.read((database) => readCandidates(database, [...indexedKeys]));
          if (observed === undefined || current.writeRevision() !== observed) {
            throw new Error("Session subagent facts changed before commit");
          }
          // Lost protection may over-preserve; newly durable protection must win over a stale resident row.
          keys.push(...protectedSubagentSessionKeys(refreshed.values()));
        }
        return keys;
      },
      dispose() {
        current?.dispose();
      },
      subagentRunBasis: prepared.basis,
    };
  } catch (error) {
    current?.dispose();
    throw error;
  }
});
