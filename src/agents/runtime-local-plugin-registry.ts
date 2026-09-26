import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createRuntimePluginManifestLookup,
  listRuntimePluginIdsFromRegistry,
} from "../plugins/active-runtime-registry.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  getPluginRegistryGatewayOwner,
  isPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
} from "../plugins/runtime/load-context.js";

/** Admit a local root only while its composition still holds exact invocation custody. */
export function resolveLocalAgentPluginRegistry(
  input: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string | null;
    allowGatewaySubagentBinding?: boolean;
  },
  metadataSnapshot: PluginMetadataSnapshot,
): PluginRegistry | undefined {
  const request = getPluginRuntimeGatewayRequestScope();
  const localRegistry = request?.context?.localEmbedded ? request.pluginRegistry : undefined;
  const localContext = localRegistry && getPluginRuntimeLoadContext(localRegistry);
  const invocation = pluginInvocationContext.getStore();
  // Only the local composition's exact live invocation can lend full callbacks.
  // A process-global registry, a Gateway binding, or matching ids alone is not custody.
  if (
    input.config &&
    input.allowGatewaySubagentBinding !== true &&
    localRegistry &&
    localContext &&
    invocation &&
    invocation.registry === localRegistry &&
    !getPluginRegistryGatewayOwner(localRegistry) &&
    !isPluginRegistryRetired(localRegistry) &&
    hashRuntimeConfigValue(projectConfigOntoRuntimeSourceSnapshot(input.config)) ===
      hashRuntimeConfigValue(localContext.activationSourceConfig) &&
    getReusablePluginRuntimeActivation(localRegistry, {
      config: input.config,
      env: input.env ?? process.env,
      workspaceDir: input.workspaceDir ?? undefined,
      metadataSnapshot,
    }) &&
    listRuntimePluginIdsFromRegistry(localRegistry).every(
      createRuntimePluginManifestLookup(localRegistry, metadataSnapshot.manifestRegistry.plugins),
    ) &&
    [...collectRegistryInvocationInstances(localRegistry)].every((instance) =>
      invocation.lookup(instance),
    )
  ) {
    invocation.assertActive();
    return localRegistry;
  }
  return undefined;
}
