import { currentPluginWorkHoldsPendingReplacement } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

/** A reload cannot wait for plugin work that is itself waiting for that reload. */
export function assertPreparedModelRuntimeAdmissionCanWait(
  owner?: Pick<PreparedModelRuntimeOwner, "needsRefresh" | "snapshot" | "refreshError">,
): void {
  if (owner && ((!owner.snapshot && !owner.refreshError) || !owner.needsRefresh)) {
    return;
  }
  const generation = getPreparedModelRuntimePluginGeneration();
  const heldTurn = generation && getPreparedModelRuntimeBorrowedSnapshot(generation);
  const holdsReloadingInstance =
    heldTurn &&
    [generation.pluginRegistry, generation.inboundPluginRegistry].some(
      (registry) =>
        registry &&
        Array.from(collectRegistryInvocationInstances(registry)).some(
          (instance) => instance.replacementPending,
        ),
    );
  if (currentPluginWorkHoldsPendingReplacement() || holdsReloadingInstance) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      { admissionBlocked: true },
    );
  }
}
