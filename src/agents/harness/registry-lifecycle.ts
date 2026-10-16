import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";

/** Capture exact lifecycle hooks before their caller can leave its runtime scope. */
export function captureAgentHarnessLifecycleHooks<
  Hook extends "withDescendantCancellation" | "withSessionDeletion" | "withSessionContextReset",
>(hook: Hook) {
  const scopedRegistry = () =>
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scoped = scopedRegistry();
  const registry = scoped ?? getPluginRegistryState()?.activeRegistry;
  return (
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
          isCurrent: () =>
            Boolean(current?.()) &&
            (!scoped || scopedRegistry() === scoped) &&
            registry.agentHarnesses.includes(registration) &&
            registration.harness[hook] === prepare,
        },
      ];
    }) ?? []
  );
}
