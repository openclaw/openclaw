import { currentPluginWorkHoldsPendingReplacement } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

// A live turn lease retains work on every instance of its generation until the turn ends.
function turnLeaseHoldsPendingReplacement(
  generation: PreparedModelRuntimePluginGeneration | undefined,
): boolean {
  if (!generation || !getPreparedModelRuntimeBorrowedSnapshot(generation)) {
    return false;
  }
  return [generation.pluginRegistry, generation.inboundPluginRegistry].some(
    (registry) =>
      registry !== undefined &&
      [...collectRegistryInvocationInstances(registry)].some(
        (instance) => instance.replacementPending,
      ),
  );
}

/** Refuses replacement waits only from work the pending reload drain is itself joining. */
export function assertPreparedModelRuntimeAdmissionCanWait(
  owner?: Pick<PreparedModelRuntimeOwner, "needsRefresh" | "snapshot" | "refreshError">,
): void {
  // Fresh construction and non-refresh discovery do not depend on draining predecessor work.
  // Auth invalidation can replace even an unpublished owner's promise with a queued transaction.
  if (owner && ((!owner.snapshot && !owner.refreshError) || !owner.needsRefresh)) {
    return;
  }
  // Waiting is safe for work the drain does not join; it resumes once the reload commits.
  // Work the drain joins would wait on the reload while the reload waits on it.
  if (
    currentPluginWorkHoldsPendingReplacement() ||
    turnLeaseHoldsPendingReplacement(getPreparedModelRuntimePluginGeneration())
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.",
      { admissionBlocked: true },
    );
  }
}
