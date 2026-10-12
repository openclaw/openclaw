import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import * as store from "./native-hook-relay-store.kernel.js";

function relayMutation<Input, Output>(
  mutate: (database: OpenClawStateDatabase, input: Input) => Output,
  requiresAdmission = false,
) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext): Output =>
    runOpenClawStateWriteTransaction(
      (database) => {
        if (requiresAdmission) {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        }
        return mutate(database, input);
      },
      { database: open(), ...stateOptions() },
    );
}

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
  "nativeHookRelay.write": relayMutation(store.writeNativeHookRelayBridgeRecordInDatabase, true),
  "nativeHookRelay.renew": relayMutation(
    store.renewOrRestoreNativeHookRelayBridgeRecordInDatabase,
    true,
  ),
  "nativeHookRelay.deleteOwned": relayMutation(
    store.deleteNativeHookRelayBridgeRecordIfOwnedInDatabase,
  ),
  "nativeHookRelay.prune": relayMutation(
    (database, input: { candidates: store.NativeHookRelayBridgePruneCandidate[]; nowMs: number }) =>
      store.pruneNativeHookRelayBridgeRecordsInDatabase(database, input.candidates, input.nowMs),
  ),
} satisfies WorkerOperationHandlers;
