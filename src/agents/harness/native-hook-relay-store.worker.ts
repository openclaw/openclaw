import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { withOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import * as store from "./native-hook-relay-store.kernel.js";

export const nativeHookRelayOperations = {
  "nativeHookRelay.read": (input: { relayId: string }, { stateOptions }) =>
    withOpenClawStateDatabaseReadOnly(
      (database) =>
        store.readNativeHookRelayBridgeSnapshotFromDatabase({ database, relayId: input.relayId })
          ?.record,
      stateOptions(),
    ),
  "nativeHookRelay.listSnapshots": (_input: undefined, { open }) =>
    store.listNativeHookRelayBridgeSnapshotsInDatabase(open()),
  "nativeHookRelay.write": (
    input: Parameters<typeof store.writeNativeHookRelayBridgeRecordInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        return store.writeNativeHookRelayBridgeRecordInDatabase(database, input);
      },
      { database: open(), ...stateOptions() },
    ),
  "nativeHookRelay.renew": (
    input: Parameters<typeof store.renewOrRestoreNativeHookRelayBridgeRecordInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        return store.renewOrRestoreNativeHookRelayBridgeRecordInDatabase(database, input);
      },
      { database: open(), ...stateOptions() },
    ),
  "nativeHookRelay.deleteOwned": (
    input: Parameters<typeof store.deleteNativeHookRelayBridgeRecordIfOwnedInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => store.deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(database, input),
      { database: open(), ...stateOptions() },
    ),
  "nativeHookRelay.prune": (
    input: { candidates: store.NativeHookRelayBridgePruneCandidate[]; nowMs: number },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) =>
        store.pruneNativeHookRelayBridgeRecordsInDatabase(database, input.candidates, input.nowMs),
      { database: open(), ...stateOptions() },
    ),
} satisfies WorkerOperationHandlers;
