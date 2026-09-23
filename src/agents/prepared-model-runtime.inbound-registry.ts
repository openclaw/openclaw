import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  listRuntimePluginIdsFromRegistry,
  createRuntimePluginManifestLookup,
} from "../plugins/active-runtime-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode,
} from "../plugins/runtime.js";
import { getReusablePluginRuntimeActivation } from "../plugins/runtime/load-context.js";
import type { RuntimePluginLoadPurpose } from "./harness/runtime-plugin-load-plan.js";
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

/** Loads generic plugin facts without acquiring model, catalog, or credential state. */
export function loadPreparedInboundPluginRegistry(
  input: PreparedInboundRegistryInput,
  metadataSnapshot = prepareOwnedPluginLoadContext(input, input.env ?? process.env, undefined),
  configuredHarnessRuntimes?: readonly string[],
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
): PluginRegistry {
  const activeRegistry = getActivePluginRegistry();
  // Registry-owned facts survive an outer reload cache without allowing stale
  // metadata or changed activation inputs to reuse already-registered callbacks.
  const reusableGatewayRegistry =
    input.allowGatewaySubagentBinding === true &&
    input.env === undefined &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable" &&
    activeRegistry &&
    getActivePluginRegistryWorkspaceDir() === metadataSnapshot.workspaceDir &&
    getReusablePluginRuntimeActivation(activeRegistry, {
      config: input.config,
      env: process.env,
      workspaceDir: metadataSnapshot.workspaceDir,
      metadataSnapshot,
    }) &&
    listRuntimePluginIdsFromRegistry(activeRegistry).every(
      createRuntimePluginManifestLookup(activeRegistry, metadataSnapshot.manifestRegistry.plugins),
    )
      ? activeRegistry
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
  purpose?: RuntimePluginLoadPurpose,
): PreparedWorkspacePluginRegistries | Promise<PreparedWorkspacePluginRegistries> {
  // Passive reads stay runtime-free; catalog workers and executable probes carry explicit scope.
  if (
    purpose !== "model-catalog" &&
    input.readOnly &&
    !input.loadRuntimePlugins &&
    !input.runtimePluginSelections
  ) {
    return {};
  }
  // Resolve batch facts only for a registry load; read-only and reused registries need no scan.
  let primaryRegistry: PluginRegistry | undefined;
  const inboundPluginRegistry =
    input.readOnly || purpose === "model-catalog"
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
    purpose === "model-catalog" || input.runtimePluginSelections || !baseRegistry
      ? loadRuntimeRegistry(
          {
            ...(purpose === "model-catalog"
              ? { basePluginIds: basePluginIds ?? [] }
              : input.loadRuntimePlugins
                ? { basePluginIds: [] }
                : baseRegistry
                  ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) }
                  : basePluginIds !== undefined
                    ? { basePluginIds }
                    : {}),
            ...(reusableGeneration?.pluginRegistry
              ? { reusableRegistry: reusableGeneration.pluginRegistry }
              : {}),
            config: input.config,
            env: input.env ?? process.env,
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
            ...(input.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
            metadataSnapshot,
            ...(preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
            selections: input.runtimePluginSelections,
            configuredHarnessRuntimes: getConfiguredHarnessRuntimes?.(),
            ...(purpose ? { purpose } : {}),
          },
          (source) => {
            loadedPrimaryRegistry =
              reusableGeneration && source === reusableGeneration.pluginRegistry
                ? (reusableGeneration.mediaCapabilityProviderSource?.registry ?? source)
                : source;
          },
        )
      : baseRegistry;
  const prepared = (registry: PluginRegistry | undefined): PreparedWorkspacePluginRegistries => {
    if (registry) {
      retainRegistry(registry);
    }
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
