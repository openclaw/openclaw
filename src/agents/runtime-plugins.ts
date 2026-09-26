import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "../config/runtime-source-projection.js";
import { projectRuntimeChangesOntoSource } from "../config/source-value-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import { adoptRuntimeDecisionProviders } from "../decisions/registry-adoption.js";
import {
  listLoadedRuntimePluginIds,
  listRuntimePluginIdsFromRegistry,
  registryContainsRuntimePluginIds,
} from "../plugins/active-runtime-registry.js";
import {
  adoptRuntimeChannelRegistrations,
  captureRuntimeChannelSource,
} from "../plugins/channel-registry-adoption.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import {
  acquirePluginRegistryForInspection,
  loadPluginRegistryHandle,
  type PluginLoadOptions,
} from "../plugins/loader.js";
import { adoptRuntimeMemoryRegistrations } from "../plugins/memory-state.js";
import {
  collectRegistryInvocationInstances,
  PluginInvocationScope,
} from "../plugins/plugin-invocation-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import {
  bindPluginRegistryGatewayOwner,
  bindPluginRegistryResourceOwner,
  getPluginRegistryGatewayOwner,
  getPluginRegistryResourceOwner,
  markPluginRegistryActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import { adoptRuntimeWidgetPresenterRegistrations } from "../plugins/widget-presenters.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections,
  type AgentHarnessPluginSelection,
  type RuntimePluginLoadPurpose,
} from "./harness/runtime-plugin-load-plan.js";
import { resolveLocalAgentPluginRegistry } from "./runtime-local-plugin-registry.js";
import { releaseRuntimePluginWork, retainRuntimePluginWork } from "./runtime-plugin-work.js";

type AgentRuntimePluginRegistryParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
  /** Explicit base scope for hosts without a Gateway startup registry. */
  basePluginIds?: readonly string[];
  /** Exact registry from the supplied lifecycle metadata generation. */
  reusableRegistry?: PluginRegistry;
  selections?: readonly AgentHarnessPluginSelection[];
  /** Config-wide harness runtimes carried by a prepared lifecycle batch. */
  configuredHarnessRuntimes?: readonly string[];
  /** Lifecycle-owned selection; standalone/direct generations stay source-default. */
  preferBuiltPluginArtifacts?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  purpose?: RuntimePluginLoadPurpose;
};

function resolveAgentRuntimePluginRegistryLoad(
  params: AgentRuntimePluginRegistryParams,
): PluginLoadOptions {
  const loadOptions: PluginLoadOptions = {
    config: params.config,
    metadataSnapshot: params.metadataSnapshot,
    activationSourceConfig: params.config && projectConfigOntoRuntimeSourceSnapshot(params.config),
    env: params.env,
    workspaceDir:
      typeof params.workspaceDir === "string" && params.workspaceDir.trim()
        ? resolveUserPath(params.workspaceDir)
        : undefined,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? { allowGatewaySubagentBinding: true }
      : undefined,
  };
  if (params.config?.plugins?.enabled === false) {
    return { ...loadOptions, onlyPluginIds: [] };
  }
  const metadataSnapshot =
    params.metadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config ?? {},
      env: params.env ?? process.env,
      workspaceDir: loadOptions.workspaceDir,
    });
  const workspaceDir = metadataSnapshot.workspaceDir ?? loadOptions.workspaceDir;
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  // Gateway-hosted fall-through must not cold-load every plugin (30-45s event-loop convoy);
  // startup runtime plugin ids plus selected run owners bound the registry scope.
  const activePluginIds = listLoadedRuntimePluginIds();
  const startupPluginIds =
    params.purpose === "model-catalog"
      ? (params.basePluginIds ?? [])
      : (params.basePluginIds ??
        (requestPluginRegistry
          ? listRuntimePluginIdsFromRegistry(requestPluginRegistry)
          : (metadataSnapshot.pluginIds ??
            (activePluginIds.length > 0 ? activePluginIds : undefined))));
  const plan = resolveAgentRuntimePluginLoadPlan({
    config: params.config,
    workspaceDir: workspaceDir ?? process.cwd(),
    basePluginIds: startupPluginIds,
    selections: resolveAgentRuntimePluginSelections(
      params.config,
      params.selections ?? [],
      params.purpose === "model-catalog" ? [] : params.configuredHarnessRuntimes,
    ),
    metadataSnapshot,
    ...(params.purpose ? { purpose: params.purpose } : {}),
  });
  // No-op plans keep the captured authored fleet by identity. Changed plans must
  // project policy edits onto that capture, not the current global generation.
  let activationSourceConfig = loadOptions.activationSourceConfig;
  if (plan.config !== params.config) {
    const projectedSource =
      params.config && activationSourceConfig
        ? projectRuntimeChangesOntoSource(activationSourceConfig, params.config, plan.config)
        : plan.config;
    // SAFETY: Typed config inputs project only the planner's plugin-policy edits onto authored config.
    activationSourceConfig = projectedSource as OpenClawConfig;
  }
  return {
    ...loadOptions,
    config: plan.config,
    activationSourceConfig,
    workspaceDir,
    metadataSnapshot,
    discovery: metadataSnapshot.discovery,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
    manifestRegistry: metadataSnapshot.manifestRegistry,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
    onlyPluginIds: startupPluginIds === undefined ? undefined : plan.pluginIds,
    channelPluginLoadIntent: startupPluginIds === undefined ? undefined : "full",
    // Expanding an admitted local root owns full capabilities as well as providers.
    // Shared Gateway discovery and provider-only catalog workers never enter this path.
    ...(params.purpose === "agent" &&
    params.reusableRegistry &&
    resolveLocalAgentPluginRegistry(params, metadataSnapshot) === params.reusableRegistry
      ? { runtimeSideEffects: true }
      : {}),
  };
}

function reusableAgentRuntimeRegistry(
  params: AgentRuntimePluginRegistryParams,
  loadOptions: PluginLoadOptions,
): PluginRegistry | undefined {
  const pluginIds = loadOptions.onlyPluginIds;
  return params.reusableRegistry &&
    pluginIds !== undefined &&
    (params.purpose !== "model-catalog" ||
      listRuntimePluginIdsFromRegistry(params.reusableRegistry).every((pluginId) =>
        pluginIds.includes(pluginId),
      )) &&
    registryContainsRuntimePluginIds(params.reusableRegistry, pluginIds)
    ? params.reusableRegistry
    : undefined;
}

function adoptAgentRuntimeRegistrations(
  pluginRegistry: PluginRegistry,
  params: AgentRuntimePluginRegistryParams,
  config: OpenClawConfig | undefined,
  channelSource: ReturnType<typeof captureRuntimeChannelSource>,
): {
  registry: PluginRegistry;
  donor?: PluginRegistry;
} {
  const activeRegistry = getActivePluginRegistry();
  if (params.purpose === "model-catalog") {
    return { registry: pluginRegistry };
  }
  const channelRegistry =
    params.allowGatewaySubagentBinding === true &&
    (params.env === undefined || params.env === process.env)
      ? adoptRuntimeChannelRegistrations(pluginRegistry, channelSource)
      : pluginRegistry;
  if (!activeRegistry) {
    return { registry: channelRegistry };
  }
  const memoryRegistry =
    params.metadataSnapshot &&
    params.workspaceDir &&
    config &&
    getActivePluginRegistryWorkspaceDir() === resolveUserPath(params.workspaceDir)
      ? adoptRuntimeMemoryRegistrations(channelRegistry, activeRegistry, config)
      : channelRegistry;
  const registry = bindPluginRegistryResourceOwner(
    adoptRuntimeWidgetPresenterRegistrations(
      adoptRuntimeContextEngineRegistrations(
        config &&
          params.allowGatewaySubagentBinding === true &&
          (params.env === undefined || params.env === process.env)
          ? adoptRuntimeDecisionProviders(memoryRegistry, activeRegistry, config)
          : memoryRegistry,
        activeRegistry,
      ),
      activeRegistry,
    ),
    pluginRegistry,
  );
  return {
    registry: bindAdmittingGateway(registry),
    ...(registry !== pluginRegistry ? { donor: activeRegistry } : {}),
  };
}

/** The admitting Gateway owns reload recovery for work that runs in a turn registry. */
function bindAdmittingGateway(registry: PluginRegistry): PluginRegistry {
  const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const admittingGateway = requestRegistry && getPluginRegistryGatewayOwner(requestRegistry);
  if (admittingGateway) {
    bindPluginRegistryGatewayOwner(registry, admittingGateway);
  }
  return registry;
}

export type AcquiredAgentRuntimePluginRegistry =
  | { registry: PluginRegistry; primaryRegistry: PluginRegistry }
  | {
      registry: PluginRegistry;
      primaryRegistry: PluginRegistry;
      resources: NonNullable<ReturnType<typeof getPluginRegistryInspectionResources>>;
      releaseRegistry: () => Promise<void>;
      releaseWork: () => void;
    };

/** Prepared read-only owners reuse the load plan while owning fresh, uncached registrations. */
export async function acquireAgentRuntimePluginRegistry(
  params: AgentRuntimePluginRegistryParams,
): Promise<AcquiredAgentRuntimePluginRegistry> {
  const loadOptions = resolveAgentRuntimePluginRegistryLoad(params);
  const reusable = reusableAgentRuntimeRegistry(params, loadOptions);
  if (reusable) {
    return { registry: bindAdmittingGateway(reusable), primaryRegistry: reusable };
  }
  const acquire = () => acquirePluginRegistryForInspection(loadOptions);
  const channelSource = captureRuntimeChannelSource(getActivePluginRegistry());
  const acquired = await (params.metadataSnapshot
    ? withPluginMetadataSnapshotScope(params.metadataSnapshot, acquire)
    : acquire());
  let releaseWork = () => {};
  try {
    const { registry, donor } = adoptAgentRuntimeRegistrations(
      acquired.registry,
      params,
      loadOptions.config,
      channelSource,
    );
    // Fence replacement before adopting donors, including the await back to the build owner.
    releaseWork = retainRuntimePluginWork([registry]);
    const primaryResources = getPluginRegistryInspectionResources(acquired.registry);
    if (!primaryResources) {
      throw new Error("Acquired prepared registry has no registration resource owner");
    }
    if (registry !== acquired.registry) {
      primaryResources.attach(registry);
    }
    if (donor) {
      primaryResources.adoptInvocations(registry, donor);
    }
    return {
      registry,
      primaryRegistry: acquired.registry,
      resources: primaryResources,
      releaseRegistry: acquired.release,
      releaseWork,
    };
  } catch (error) {
    try {
      await releaseRuntimePluginWork(acquired.release, releaseWork);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Prepared registry acquisition and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Loads the registry handle owned by an agent prepared-runtime generation. */
export function loadAgentRuntimePluginRegistryHandle(
  params: AgentRuntimePluginRegistryParams,
  onPrimaryRegistry?: (registry: PluginRegistry) => void,
): PluginRegistry {
  const loadOptions = resolveAgentRuntimePluginRegistryLoad(params);
  const reusable = reusableAgentRuntimeRegistry(params, loadOptions);
  if (reusable) {
    onPrimaryRegistry?.(reusable);
    return bindAdmittingGateway(reusable);
  }
  // Shared-host discovery must not replace process-global sandbox backends.
  // Only a compatible local composition above can admit a full selected expansion.
  // Adopt full-only runtime capabilities from the matching composition-root owners.
  // Prepared metadata outlives a transient caller's install or reload lease.
  const load = () => loadPluginRegistryHandle(loadOptions);
  const channelSource = captureRuntimeChannelSource(getActivePluginRegistry());
  const pluginRegistry = params.metadataSnapshot
    ? withPluginMetadataSnapshotScope(params.metadataSnapshot, load)
    : load();
  // Media providers remain owned by this source when full-only donors require a copy.
  onPrimaryRegistry?.(pluginRegistry);
  return adoptAgentRuntimeRegistrations(pluginRegistry, params, loadOptions.config, channelSource)
    .registry;
}

type AgentPluginRegistryParams<T> = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  selections?: readonly AgentHarnessPluginSelection[];
  workspaceDir: string;
  run: (pluginRegistry: PluginRegistry) => Promise<T>;
};

/** Local composition owns full capabilities for the selected config and workspace. */
export async function withLocalAgentPluginRegistry<T>(
  params: Omit<AgentPluginRegistryParams<T>, "selections">,
): Promise<T> {
  const request = getPluginRuntimeGatewayRequestScope();
  const requestRegistry = request?.pluginRegistry;
  const gatewayRegistry =
    requestRegistry && getPluginRegistryGatewayOwner(requestRegistry)?.current();
  // A Gateway-owned request follows its own admission contract. A local nested
  // call may borrow only the exact live root with matching load facts and custody.
  if (
    requestRegistry &&
    gatewayRegistry &&
    getPluginRegistryResourceOwner(gatewayRegistry) ===
      getPluginRegistryResourceOwner(requestRegistry) &&
    !request?.context?.localEmbedded
  ) {
    return await withAgentPluginRegistry(params);
  }
  const currentLocal = requestRegistry && getPluginRuntimeLoadContext(requestRegistry);
  if (currentLocal?.metadataSnapshot) {
    const compatible = resolveLocalAgentPluginRegistry(params, currentLocal.metadataSnapshot);
    if (compatible) {
      return await params.run(compatible);
    }
  }
  const rootInputConfig = captureRuntimeConfig(params.config);
  const [
    { resolvePluginRuntimeLoadContext },
    { buildPluginRuntimeLoadOptions },
    { loadGatewayStartupPluginPlan },
    { getCliPluginInvocationResources },
  ] = await Promise.all([
    import("../plugins/runtime/load-context.resolve.js"),
    import("../plugins/runtime/load-context.js"),
    import("../plugins/gateway-startup-plugin-ids.js"),
    import("../cli/runtime-cleanup-scope.js"),
  ]);
  const context = resolvePluginRuntimeLoadContext({
    config: rootInputConfig,
    activationSourceConfig: projectConfigOntoRuntimeSourceSnapshot(rootInputConfig),
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
  const authored = normalizePluginsConfig(context.activationSourceConfig.plugins);
  // Reuse startup selection, preserving every explicit local allow/enable choice.
  // Auto-enable's picker-only provider entries are availability, not a turn selection.
  const pluginIds = authored.enabled
    ? [
        ...new Set([
          ...authored.allow,
          ...Object.entries(authored.entries)
            .filter(([, entry]) => entry.enabled === true)
            .map(([id]) => id),
          ...loadGatewayStartupPluginPlan({
            config: context.config,
            activationSourceConfig: context.activationSourceConfig,
            env: context.env,
            workspaceDir: context.workspaceDir,
            metadataSnapshot: context.metadataSnapshot,
          }).pluginIds,
        ]),
      ]
    : [];
  // The existing executable owner joins terminal harness cleanup before retiring
  // this exact handle. Programmatic local calls retire their own handle on return.
  const resources = getCliPluginInvocationResources();
  const load = () => {
    const registry = loadPluginRegistryHandle(
      buildPluginRuntimeLoadOptions(context, {
        onlyPluginIds: pluginIds,
        cache: false,
        throwOnLoadError: true,
        runtimeSideEffects: true,
      }),
    );
    // Prepared generations borrow an already-owned handle rather than opening a
    // second lifetime whose retirement would compete with this caller's release.
    markPluginRegistryActive(registry);
    return registry;
  };
  const registry = resources
    ? await resources.acquire(async () => {
        const ownedRegistry = load();
        return {
          registry: ownedRegistry,
          release: async () => {
            await disposePluginRegistryInstances(ownedRegistry);
          },
        };
      })
    : load();
  let invocations: PluginInvocationScope | undefined;
  try {
    const registered = getPluginRuntimeLoadContext(registry);
    if (!registered?.metadataSnapshot) {
      throw new Error("Local plugin root has no prepared metadata generation");
    }
    // The loader registered the auto-enabled config; preparation receives the
    // admitted runtime input. Preserve that immutable input as the root's raw
    // activation fact without changing its registered callbacks or result.
    setPluginRuntimeLoadContext(registry, { ...registered, rawConfig: rootInputConfig });
    const invocation = new PluginInvocationScope(
      registry,
      collectRegistryInvocationInstances(registry),
      { retained: true },
    );
    invocations = invocation;
    return await withPluginMetadataSnapshotScope(
      registered.metadataSnapshot,
      () =>
        withPluginRuntimeRegistryScope(registry, () => invocation.run(() => params.run(registry))),
      { config: rootInputConfig, env: context.env, workspaceDir: context.workspaceDir },
    );
  } finally {
    invocations?.release();
    if (!resources) {
      await disposePluginRegistryInstances(registry);
    }
  }
}

/** Binds a scoped plugin generation when a direct host has no Gateway owner. */
export async function withAgentPluginRegistry<T>(params: AgentPluginRegistryParams<T>): Promise<T> {
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  if (requestPluginRegistry && params.selections === undefined) {
    return await params.run(requestPluginRegistry);
  }
  // Borrowed Gateway registries must not load direct-host context dependencies.
  const { resolvePluginRuntimeLoadContext } =
    await import("../plugins/runtime/load-context.resolve.js");
  // Direct hosts resolve one policy generation; disabled plugins never reopen discovery.
  const context = resolvePluginRuntimeLoadContext({
    config: params.config,
    activationSourceConfig: projectConfigOntoRuntimeSourceSnapshot(params.config),
    env: params.env,
    workspaceDir: params.workspaceDir,
    ...(params.config.plugins?.enabled === false
      ? { manifestRegistry: { plugins: [], diagnostics: [] } }
      : { metadataSnapshot: loadPluginMetadataSnapshot(params) }),
  });
  // The resolver inherits request or configured scope; an empty override drops hook-only plugins.
  const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
    config: params.config,
    env: context.env,
    metadataSnapshot: context.metadataSnapshot,
    selections: params.selections,
    workspaceDir: params.workspaceDir,
  });
  setPluginRuntimeLoadContext(pluginRegistry, context);
  const invocations = new PluginInvocationScope(
    pluginRegistry,
    collectRegistryInvocationInstances(pluginRegistry),
  );
  return await withPluginRuntimeRegistryScope(pluginRegistry, () =>
    invocations.run(() => params.run(pluginRegistry)),
  );
}
