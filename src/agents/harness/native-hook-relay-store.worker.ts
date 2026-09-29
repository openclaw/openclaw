import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  deleteNativeHookRelayBridgeRecordIfOwnedInDatabase,
  pruneNativeHookRelayBridgeRecordsInDatabase,
  renewOrRestoreNativeHookRelayBridgeRecordInDatabase,
  writeNativeHookRelayBridgeRecordInDatabase,
} from "./native-hook-relay-store.kernel.js";
import type { NativeHookRelayStoreWorkerOperations } from "./native-hook-relay-store.worker-contract.js";

type NativeHookRelayMutationCommand = SqliteWorkerCommand<
  Omit<
    NativeHookRelayStoreWorkerOperations,
    "nativeHookRelay.read" | "nativeHookRelay.listSnapshots"
  >
>;

export function executeNativeHookRelayMutation(
  command: NativeHookRelayMutationCommand,
  options: OpenClawStateDatabaseOptions,
) {
  return runOpenClawStateWriteTransaction((database) => {
    switch (command.type) {
      case "nativeHookRelay.write":
      case "nativeHookRelay.renew":
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        return command.type === "nativeHookRelay.write"
          ? writeNativeHookRelayBridgeRecordInDatabase(database, command.input)
          : renewOrRestoreNativeHookRelayBridgeRecordInDatabase(database, command.input);
      case "nativeHookRelay.deleteOwned":
        return deleteNativeHookRelayBridgeRecordIfOwnedInDatabase(database, command.input);
      case "nativeHookRelay.prune":
        return pruneNativeHookRelayBridgeRecordsInDatabase(
          database,
          command.input.candidates,
          command.input.nowMs,
        );
    }
  }, options);
}
