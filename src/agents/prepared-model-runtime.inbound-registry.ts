import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  listRuntimePluginIdsFromRegistry,
  createRuntimePluginManifestLookup,
} from "../plugins/active-runtime-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryGatewayOwner } from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
} from "../plugins/runtime/load-context.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

type PreparedInboundRegistryInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "env" | "workspaceDir" | "allowGatewaySubagentBinding"
>;

export type PreparedInboundRegistryLoader = (
  input: PreparedInboundRegistryInput,
  metadataSnapshot: PluginMetadataSnapshot,
  configuredHarnessRuntimes?: readonly string[],
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
) => PluginRegistry;

function inboundRegistryIdentity(input: PreparedInboundRegistryInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
  });
}

/** Groups model-selected workspace facts while keeping generic inbound identity narrower. */
export function preparedModelRuntimeWorkspaceFactsKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    config: hashRuntimeConfigValue(input.config),
    env: hashRuntimeConfigValue(input.env ?? process.env),
    readOnly: input.readOnly === true,
    loadRuntimePlugins: input.loadRuntimePlugins === true,
    runtimePluginPurpose: input.runtimePluginPurpose,
    workspaceDir: input.workspaceDir,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    // Normalization already resolves each model to its runtime. The workspace
    // registry depends on provider/runtime ownership, not the model id itself.
    runtimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({
      provider,
      runtime,
    })),
  });
}

/** Gateway-hosted prepared loads borrow unchanged instances from the live Gateway registry. */
function resolveLendingGatewayRegistry(
  input: PreparedInboundRegistryInput,
  metadataSnapshot: PluginMetadataSnapshot,
): PluginRegistry | undefined {
  if (input.allowGatewaySubagentBinding !== true || input.env !== undefined) {
    return undefined;
  }
  // Startup and admitted turns carry their Gateway registry through the same scope.
  // A process-active sibling with matching files is not this caller's runtime owner.
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const registry = requestRegistry && getPluginRegistryGatewayOwner(requestRegistry)?.current();
  return registry &&
    getPluginRuntimeLoadContext(registry)?.workspaceDir === metadataSnapshot.workspaceDir
    ? registry
    : undefined;
}

/** Loads generic plugin facts without acquiring model, catalog, or credential state. */
export function loadPreparedInboundPluginRegistry(
  input: PreparedInboundRegistryInput,
  metadataSnapshot = prepareOwnedPluginLoadContext(input, input.env ?? process.env, undefined),
  configuredHarnessRuntimes?: readonly string[],
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
): PluginRegistry {
  const gatewayRegistry = resolveLendingGatewayRegistry(input, metadataSnapshot);
  // Registry-owned facts survive an outer reload cache without allowing stale
  // metadata or changed activation inputs to reuse already-registered callbacks.
  const reusableGatewayRegistry =
    gatewayRegistry &&
    getReusablePluginRuntimeActivation(gatewayRegistry, {
      config: input.config,
      env: process.env,
      workspaceDir: metadataSnapshot.workspaceDir,
      metadataSnapshot,
    }) &&
    listRuntimePluginIdsFromRegistry(gatewayRegistry).every(
      createRuntimePluginManifestLookup(gatewayRegistry, metadataSnapshot.manifestRegistry.plugins),
    )
      ? gatewayRegistry
      : undefined;
  const registry =
    reusableGatewayRegistry ??
    loadAgentRuntimePluginRegistryHandle(
      {
        config: input.config,
        env: input.env ?? process.env,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
        ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
        metadataSnapshot,
        preferBuiltPluginArtifacts: true,
        configuredHarnessRuntimes,
        borrowRegistry: gatewayRegistry,
      },
      onPrimaryRegistry,
    );
  if (reusableGatewayRegistry) {
    onPrimaryRegistry?.(reusableGatewayRegistry);
  }
  prepareOwnedPluginLoadContext(input, input.env ?? process.env, registry, metadataSnapshot, true);
  return registry;
}

/** Creates one lifecycle-batch loader that shares exact generic registry identities. */
export function createPreparedInboundRegistryLoader(): PreparedInboundRegistryLoader {
  const registries = new Map<
    string,
    {
      metadataSnapshot: PluginMetadataSnapshot;
      registry: PluginRegistry;
      primaryRegistry: PluginRegistry;
    }
  >();
  return (input, metadataSnapshot, configuredHarnessRuntimes, onPrimaryRegistry) => {
    const key = inboundRegistryIdentity(input);
    const existing = registries.get(key);
    if (existing?.metadataSnapshot === metadataSnapshot) {
      onPrimaryRegistry?.(existing.primaryRegistry);
      return existing.registry;
    }
    let primaryRegistry: PluginRegistry | undefined;
    const registry = loadPreparedInboundPluginRegistry(
      input,
      metadataSnapshot,
      configuredHarnessRuntimes,
      (source) => {
        primaryRegistry = source;
      },
    );
    primaryRegistry ??= registry;
    registries.set(key, { metadataSnapshot, registry, primaryRegistry });
    onPrimaryRegistry?.(primaryRegistry);
    return registry;
  };
}

type PreparedWorkspacePluginRegistries = {
  runtimePluginRegistry?: PluginRegistry;
  inboundPluginRegistry?: PluginRegistry;
  primaryRegistry?: PluginRegistry;
};

/** Prepares distinct generic-inbound and model-selected registries for one workspace generation. */
export function prepareWorkspacePluginRegistries(
  input: PreparedModelRuntimeInput,
  metadataSnapshot: PluginMetadataSnapshot,
  retainRegistry: (registry: PluginRegistry) => void,
  loadInboundRegistry?: PreparedInboundRegistryLoader,
  preferBuiltPluginArtifacts = false,
  reusableGeneration?: PreparedModelRuntimePluginGeneration,
  getConfiguredHarnessRuntimes?: () => readonly string[],
  basePluginIds?: readonly string[],
  loadRuntimeRegistry:
    | PreparedModelRuntimeBuildResources["load"]
    | typeof loadAgentRuntimePluginRegistryHandle = loadAgentRuntimePluginRegistryHandle,
): PreparedWorkspacePluginRegistries | Promise<PreparedWorkspacePluginRegistries> {
  // Passive reads stay runtime-free; executable probes carry explicit scope.
  if (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) {
    return {};
  }
  // Resolve batch facts only for a registry load; read-only and reused registries need no scan.
  let primaryRegistry: PluginRegistry | undefined;
  const inboundPluginRegistry =
    input.readOnly || input.runtimePluginPurpose === "isolated-completion"
      ? undefined
      : (reusableGeneration?.inboundPluginRegistry ??
        loadInboundRegistry?.(
          input,
          metadataSnapshot,
          getConfiguredHarnessRuntimes?.(),
          (source) => {
            primaryRegistry = source;
          },
        ));
  const baseRegistry = reusableGeneration?.pluginRegistry ?? inboundPluginRegistry;
  for (const registry of new Set([inboundPluginRegistry, baseRegistry])) {
    if (registry) {
      retainRegistry(registry);
    }
  }
  primaryRegistry ??= reusableGeneration?.mediaCapabilityProviderSource?.registry ?? baseRegistry;
  let loadedPrimaryRegistry: PluginRegistry | undefined;
  const runtimePluginRegistry =
    input.runtimePluginSelections || !baseRegistry
      ? loadRuntimeRegistry(
          {
            ...(input.loadRuntimePlugins
              ? { basePluginIds: [] }
              : baseRegistry
                ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) }
                : basePluginIds !== undefined
                  ? { basePluginIds }
                  : {}),
            // Inbound preparation already admitted this exact context. Let the runtime
            // planner check selected owners before acquiring another captured registry.
            ...(baseRegistry ? { reusableRegistry: baseRegistry } : {}),
            purpose: input.runtimePluginPurpose,
            config: input.config,
            env: input.env ?? process.env,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
            ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
            metadataSnapshot,
            ...(preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
            selections: input.runtimePluginSelections,
            configuredHarnessRuntimes: getConfiguredHarnessRuntimes?.(),
            borrowRegistry: resolveLendingGatewayRegistry(input, metadataSnapshot),
          },
          (source) => {
            loadedPrimaryRegistry =
              reusableGeneration && source === reusableGeneration.pluginRegistry
                ? (reusableGeneration.mediaCapabilityProviderSource?.registry ?? source)
                : source;
          },
        )
      : baseRegistry;
  const prepared = (registry: PluginRegistry): PreparedWorkspacePluginRegistries => {
    retainRegistry(registry);
    return {
      runtimePluginRegistry: registry,
      primaryRegistry:
        registry === baseRegistry
          ? (primaryRegistry ?? registry)
          : (loadedPrimaryRegistry ?? registry),
      ...(inboundPluginRegistry ? { inboundPluginRegistry } : {}),
    };
  };
  return runtimePluginRegistry instanceof Promise
    ? runtimePluginRegistry.then(prepared)
    : prepared(runtimePluginRegistry);
}
