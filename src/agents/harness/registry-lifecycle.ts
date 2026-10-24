import { getPluginInstanceOwner } from "../../plugins/plugin-instance-scope.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";

/** Capture exact lifecycle hooks before their caller can leave its runtime scope. */
export function captureAgentHarnessLifecycleHooks<
  Hook extends
    | "withDescendantCancellation"
    | "withSessionDeletion"
    | "withSessionContextReset"
    | "readNativeSubagents",
>(hook: Hook) {
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  const owners =
    registry?.agentHarnesses.flatMap((registration) => {
      const prepare = registration.harness[hook];
      if (!prepare) {
        return [];
      }
      const record = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
      const current =
        record || registration.pluginId === "core"
          ? capturePluginLifecycleAuthority(registry, record, {
              scopedRuntime: scoped === registry,
            })
          : undefined;
      return [
        {
          registration,
          prepare,
          record,
          isCurrent: () =>
            Boolean(current?.()) &&
            (!scoped || isScopeCurrent()) &&
            registry.agentHarnesses.includes(registration) &&
            registration.harness[hook] === prepare,
        },
      ];
    }) ?? [];
  const isScopeCurrent = () => {
    const active = scopedRegistry();
    if (active === scoped) {
      return true;
    }
    // Wrapped hooks run in their owning instance's frame; nested hooks may
    // continue in any captured owner's frame until the deletion settles.
    return (
      active !== undefined &&
      owners.some(({ record }) => {
        const owner = record && getPluginInstanceOwner(record);
        return owner?.registry === active && owner.instance?.hasActiveCall === true;
      })
    );
  };
  return owners;
}
