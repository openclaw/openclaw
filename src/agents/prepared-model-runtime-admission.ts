import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import {
  currentPluginWorkPendingReplacements,
  currentPluginWorkHoldsPendingReplacement,
} from "../plugins/plugin-instance-scope.js";
import type { PluginInvocationInstance } from "../plugins/plugin-instance.types.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import {
  readPluginReplacementOperation,
  type PluginReplacementOperation,
} from "../plugins/plugin-replacement-operation.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

type PreparedRuntimeSelfHold = Readonly<{
  held: readonly Readonly<{
    instance: Pick<PluginInvocationInstance, "pluginId">;
    pluginId: string;
    operation: PluginReplacementOperation;
  }>[];
}>;
const selfHolds = new WeakMap<object, PreparedRuntimeSelfHold>();

/** Only a guard-issued cause carries this fact; serialized or forged errors cannot. */
export function readPreparedRuntimeSelfHold(error: unknown) {
  for (const cause of collectNestedErrorCandidates(error)) {
    if (cause && typeof cause === "object") {
      const fact = selfHolds.get(cause);
      if (fact) {
        return { cause, ...fact };
      }
    }
  }
  return undefined;
}

/** A reload cannot wait for plugin work that is itself waiting for that reload. */
export function assertPreparedModelRuntimeAdmissionCanWait(
  owner?: Pick<PreparedModelRuntimeOwner, "needsRefresh" | "snapshot" | "refreshError">,
): void {
  if (owner && ((!owner.snapshot && !owner.refreshError) || !owner.needsRefresh)) {
    return;
  }
  const generation = getPreparedModelRuntimePluginGeneration();
  const heldTurn = generation && getPreparedModelRuntimeBorrowedSnapshot(generation);
  const heldInstances = new Set(currentPluginWorkPendingReplacements());
  if (heldTurn) {
    for (const registry of [generation.pluginRegistry, generation.inboundPluginRegistry]) {
      for (const instance of registry ? collectRegistryInvocationInstances(registry) : []) {
        if (instance.replacementPending) {
          heldInstances.add(instance);
        }
      }
    }
  }
  if (heldInstances.size || currentPluginWorkHoldsPendingReplacement()) {
    const error = new PreparedModelRuntimeOwnerNotPublishedError(
      "This turn holds a plugin being replaced and cannot wait for its own reload. Do not resend while this turn holds the runtime; inspect the original operation after this turn ends.",
      { admissionBlocked: true },
    );
    const held: PreparedRuntimeSelfHold["held"][number][] = [];
    for (const instance of heldInstances) {
      const operation = readPluginReplacementOperation(instance);
      // A reservation without an owned outcome refuses immediately and cannot authorize retention.
      if (!operation) {
        throw error;
      }
      held.push({ instance, pluginId: instance.pluginId, operation });
    }
    if (held.length) {
      selfHolds.set(error, { held });
    }
    throw error;
  }
}
