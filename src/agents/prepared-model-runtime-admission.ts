import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  pluginInvocationContext,
  currentPluginWorkPendingReplacements,
  currentPluginWorkHoldsPendingReplacement,
} from "../plugins/plugin-instance-scope.js";
import type { PluginInvocationInstance } from "../plugins/plugin-instance.types.js";
import {
  readPluginReplacementOperation,
  type PluginReplacementOperation,
} from "../plugins/plugin-replacement-operation.js";
import { AsyncContext } from "../shared/async-context.js";
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

type AdmissionHolds = {
  instances: readonly Pick<PluginInvocationInstance, "pluginId">[];
  holdsPendingReplacement: boolean;
};
const capturedAdmissionHolds = new AsyncContext<() => AdmissionHolds>(
  Symbol.for("openclaw.preparedModelRuntimeAdmissionHolds"),
);

/** Carry only live self-hold facts while a detached child is being admitted. */
export async function withCapturedPreparedModelRuntimeAdmissionHolds<T>(
  run: () => Promise<T>,
): Promise<T> {
  let invocation = pluginInstanceInvocation.getStore();
  let context = pluginInvocationContext.getStore();
  let inherited = capturedAdmissionHolds.getStore();
  const read = (): AdmissionHolds => {
    const parent = inherited?.();
    const instance = invocation?.instance;
    return {
      instances: [
        ...(parent?.instances ?? []),
        ...(instance && invocation && instance.holdsPendingReplacement(invocation.token)
          ? [instance]
          : []),
        ...(context?.pendingReplacementInstances ?? []),
      ],
      holdsPendingReplacement:
        parent?.holdsPendingReplacement === true || context?.holdsPendingReplacement === true,
    };
  };
  try {
    return await capturedAdmissionHolds.run(read, run);
  } finally {
    invocation = undefined;
    context = undefined;
    inherited = undefined;
  }
}

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
  const captured = capturedAdmissionHolds.getStore()?.();
  const heldInstances = new Set([
    ...currentPluginWorkPendingReplacements(),
    ...(captured?.instances ?? []),
  ]);
  if (
    heldInstances.size ||
    currentPluginWorkHoldsPendingReplacement() ||
    captured?.holdsPendingReplacement
  ) {
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
