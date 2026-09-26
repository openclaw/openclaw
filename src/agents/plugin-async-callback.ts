import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback.store.js";

type Command = {
  [
    K in keyof import("./plugin-async-callback.worker-contract.js").PluginAsyncCallbackWorkerOperations
  ]: {
    type: K;
    input: OpenClawStateWorkerOperations[K]["input"];
  };
}[keyof import("./plugin-async-callback.worker-contract.js").PluginAsyncCallbackWorkerOperations];

/** Host-only worker seam. The caller must derive every binding field from the native child owner. */
export async function runPluginAsyncCallbackCommand<T extends Command>(
  command: T,
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<OpenClawStateWorkerOperations[T["type"]]["output"]> {
  const binding = "binding" in command.input ? command.input.binding : undefined;
  const check = () => {
    context.admission.assertCurrent();
    if (binding) {
      assertOwnerCurrent(binding);
    }
  };
  const result = await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    assertCurrent: check,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((_request, grant) => {
        check();
        grant();
      }),
    }),
  });
  // A commit may have succeeded just before the owner closed. The durable row
  // remains authoritative; startup recovery finds it if no runtime can schedule.
  if (
    command.type === "pluginCallback.complete" &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "accepted"
  ) {
    await scheduleSessionDelivery(result.queueId, context);
  }
  if (
    command.type === "pluginCallback.issue" &&
    typeof result === "object" &&
    result &&
    "queueId" in result
  ) {
    await scheduleSessionDelivery(result.queueId, context);
  }
  // SAFETY: execute dispatches this discriminated command to its matching typed worker operation.
  return result as OpenClawStateWorkerOperations[T["type"]]["output"];
}
