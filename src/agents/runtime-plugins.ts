import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayStartupPluginPlan } from "../plugins/channel-plugin-ids.js";
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

function resolveStartupPluginIds(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string[] {
  return (
    resolveStartupPluginIdsFromCurrentSnapshot(params) ??
    loadGatewayStartupPluginPlan({
      config: params.config ?? {},
      activationSourceConfig: params.config ?? {},
      workspaceDir: params.workspaceDir,
      env: process.env,
    }).pluginIds
  );
}

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
  forceLoad?: boolean;
}): void {
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return;
  }
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const startupPluginIds = resolveStartupPluginIds({
    config: params.config,
    workspaceDir,
  });
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: startupPluginIds,
    ...(params.forceLoad ? { forceLoad: true } : {}),
    loadOptions: {
      config: params.config,
      workspaceDir,
      onlyPluginIds: startupPluginIds,
      runtimeOptions: allowGatewaySubagentBinding
        ? { allowGatewaySubagentBinding: true }
        : undefined,
    },
  });
}
