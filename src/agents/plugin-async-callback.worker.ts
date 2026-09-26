import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  expirePluginAsyncCallbackInDatabase,
  issuePluginAsyncCallbackInDatabase,
  completePluginAsyncCallbackInDatabase,
  cancelPluginAsyncCallbackInDatabase,
  findPluginAsyncCallbackInDatabase,
  type PluginAsyncCallbackBinding,
} from "./plugin-async-callback.store.js";
import type { PluginAsyncCallbackWorkerOperations } from "./plugin-async-callback.worker-contract.js";

type CallbackCommand = {
  [K in keyof PluginAsyncCallbackWorkerOperations]: {
    type: K;
    input: PluginAsyncCallbackWorkerOperations[K]["input"];
  };
}[keyof PluginAsyncCallbackWorkerOperations];

function assertExactBinding(
  expected: PluginAsyncCallbackBinding,
  actual: Readonly<PluginAsyncCallbackBinding>,
) {
  if (
    actual.pluginId !== expected.pluginId ||
    actual.toolName !== expected.toolName ||
    actual.childSessionKey !== expected.childSessionKey ||
    actual.childSessionId !== expected.childSessionId ||
    actual.childRunId !== expected.childRunId ||
    actual.childGeneration !== expected.childGeneration ||
    actual.childCreatedAt !== expected.childCreatedAt
  ) {
    throw new Error("Callback owner binding changed");
  }
}

/** The host admission guards the live plugin and child on the main thread at both stages. */
export function executePluginAsyncCallbackCommand(
  command: CallbackCommand,
  options: OpenClawStateDatabaseOptions,
): PluginAsyncCallbackWorkerOperations[keyof PluginAsyncCallbackWorkerOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    (database) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      let outcome;
      switch (command.type) {
        case "pluginCallback.expire":
          outcome = expirePluginAsyncCallbackInDatabase(database, command.input.key);
          break;
        case "pluginCallback.lookup":
          outcome = findPluginAsyncCallbackInDatabase(database, command.input.token);
          break;
        case "pluginCallback.issue":
          outcome = issuePluginAsyncCallbackInDatabase(
            database,
            command.input.binding,
            command.input.ttlMs,
          );
          break;
        case "pluginCallback.complete":
          outcome = completePluginAsyncCallbackInDatabase({
            database,
            token: command.input.token,
            resultText: command.input.resultText,
            assertOwnerCurrent: (actual) => assertExactBinding(command.input.binding, actual),
          });
          break;
        case "pluginCallback.cancel":
          outcome = cancelPluginAsyncCallbackInDatabase(database, command.input.token, (actual) =>
            assertExactBinding(command.input.binding, actual),
          );
          break;
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return outcome;
    },
    options,
    { operationLabel: command.type },
  );
}
