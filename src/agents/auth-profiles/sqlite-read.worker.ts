import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { AuthProfileReadWorkerOperations } from "./sqlite-read.js";
import { closeAuthProfileReadPool, inspectAuthProfileJsonCellReadOnly } from "./sqlite.js";

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<AuthProfileReadWorkerOperations> {
  const target = { kind: "agent" as const, path: context.databasePath };
  return {
    execute() {
      return {
        store: inspectAuthProfileJsonCellReadOnly(target, "store"),
        state: inspectAuthProfileJsonCellReadOnly(target, "state"),
      };
    },
    close() {
      closeAuthProfileReadPool({ kind: "database", databasePath: context.databasePath });
    },
  };
}
