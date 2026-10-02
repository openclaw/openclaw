import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import type {
  QueuedSessionDelivery,
  SessionDeliverySettledOutcome,
} from "../infra/session-delivery-queue.records.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  isMemorySessionDelivery,
  settleMemoryPluginCallback,
} from "./plugin-async-callback-memory.js";
import type { PluginAsyncCallbackBinding } from "./plugin-async-callback-policy.js";

type Command = {
  [
    K in keyof import("./plugin-async-callback.worker-contract.js").PluginAsyncCallbackWorkerOperations
  ]: {
    type: K;
    input: OpenClawStateWorkerOperations[K]["input"];
  };
}[keyof import("./plugin-async-callback.worker-contract.js").PluginAsyncCallbackWorkerOperations];

/** Host-only worker seam. The caller must derive every binding field from the native child owner. */
export function runPluginAsyncCallbackCommand<T extends Command>(
  command: T,
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void,
  context?: OpenClawStateWorkerContext,
): Promise<OpenClawStateWorkerOperations[T["type"]]["output"]>;
export async function runPluginAsyncCallbackCommand(
  command: Command,
  assertOwnerCurrent: (binding: Readonly<PluginAsyncCallbackBinding>) => void,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<OpenClawStateWorkerOperations[Command["type"]]["output"]> {
  const binding = "binding" in command.input ? command.input.binding : undefined;
  const check = () => {
    context.admission.assertCurrent();
    if (binding) {
      assertOwnerCurrent(binding);
    }
  };
  const options = {
    assertCurrent: check,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((_request, grant) => {
        check();
        grant();
      }),
    }),
  };
  // Keep post-commit scheduling outside the admitted worker operation. A status
  // receipt saying "accepted" is not a new completion or a scheduling command.
  if (command.type === "pluginCallback.complete") {
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      options,
    );
    if (result.status === "accepted") {
      await scheduleSessionDelivery(result.queueId, context);
    }
    return result;
  }
  if (command.type === "pluginCallback.issue") {
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      options,
    );
    await scheduleSessionDelivery(result.queueId, context);
    return result;
  }
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), options);
}

/** Native delivery records the terminal outcome before its durable queue receipt is retired. */
export async function settlePluginAsyncCallbackDelivery(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  if (entry.kind !== "nativeChildFollowup" || !entry.callbackKey || !entry.callbackSlot) {
    return;
  }
  if (isMemorySessionDelivery(entry.id)) {
    settleMemoryPluginCallback(entry, outcome);
    return;
  }
  await runPluginAsyncCallbackCommand(
    {
      type: "pluginCallback.settle",
      input: {
        key: entry.callbackKey,
        slot: entry.callbackSlot,
        queueId: entry.id,
        expiry: entry.callbackExpiryKey !== undefined,
        outcome: outcome === "recovered" ? "delivered" : "failed",
      },
    },
    () => context.admission.assertCurrent(),
    context,
  );
}
