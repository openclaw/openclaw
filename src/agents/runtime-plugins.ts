/**
 * Ensures runtime plugin registries are loaded for agent execution. Startup
 * plugin IDs from metadata scope the load when available.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "../plugins/runtime/standalone-runtime-registry-loader.js";
import { resolveUserPath } from "../utils.js";

type StartupScopedPluginSnapshot = NonNullable<
  ReturnType<typeof getCurrentPluginMetadataSnapshot>
> & {
  startup?: {
    pluginIds?: readonly unknown[];
  };
};

function resolveStartupPluginIdsFromCurrentSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string[] | undefined {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }) as StartupScopedPluginSnapshot | undefined;
  const pluginIds = snapshot?.startup?.pluginIds;
  if (!Array.isArray(pluginIds)) {
    return undefined;
  }
  return pluginIds.filter((pluginId): pluginId is string => typeof pluginId === "string");
}

/** Ensure standalone runtime plugins are loaded for the current agent context. */
export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return;
  }
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
    config: params.config,
    workspaceDir,
  });
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const loadOptions = {
    config: params.config,
    workspaceDir,
    ...(startupPluginIds === undefined ? {} : { onlyPluginIds: startupPluginIds }),
    ...(startupPluginIds === undefined ? {} : { forceFullRuntimeForChannelPlugins: true }),
    runtimeOptions: allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : undefined,
  };
  // Activating a replacement registry retires the active one and runs its
  // plugin host cleanup, which cron.remove()s persistent plugin-scheduled
  // jobs the replacement hasn't re-registered yet (async, still in flight).
  // Skip the reload ONLY when an active registry is already compatible with
  // THIS call's workspace/plugin-scope/config/runtime-mode — reusing the
  // existing loader cache-key compatibility rules via
  // getLoadedRuntimePluginRegistry. A presence-only check (any registry active
  // => skip) is unsafe: a later call requesting a different workspace could
  // silently keep an unrelated workspace's registry active instead of loading
  // its own (found in upstream review of this exact fix, PR #107752).
  if (
    getLoadedRuntimePluginRegistry({
      loadOptions,
      workspaceDir,
      requiredPluginIds: startupPluginIds,
    })
  ) {
    return;
  }
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: startupPluginIds,
    loadOptions,
  });
}
