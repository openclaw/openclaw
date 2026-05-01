import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode,
} from "../plugins/runtime.js";
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

function activeRegistryCoversStartupScope(params: {
  pluginIds: readonly string[];
  workspaceDir?: string;
  allowGatewaySubagentBinding: boolean;
}): boolean {
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return false;
  }
  if (
    params.allowGatewaySubagentBinding &&
    getActivePluginRuntimeSubagentMode() !== "gateway-bindable"
  ) {
    return false;
  }
  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  if (
    activeWorkspaceDir !== undefined &&
    params.workspaceDir !== undefined &&
    activeWorkspaceDir !== params.workspaceDir
  ) {
    return false;
  }
  const activePluginIds = new Set(activeRegistry.plugins.map((plugin) => plugin.id));
  return params.pluginIds.every((pluginId) => activePluginIds.has(pluginId));
}

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
    config: params.config,
    workspaceDir,
  });
  if (
    startupPluginIds &&
    activeRegistryCoversStartupScope({
      pluginIds: startupPluginIds,
      workspaceDir,
      allowGatewaySubagentBinding,
    })
  ) {
    return;
  }
  const loadOptions = {
    config: params.config,
    workspaceDir,
    ...(startupPluginIds ? { onlyPluginIds: startupPluginIds } : {}),
    runtimeOptions: allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  resolveRuntimePluginRegistry(loadOptions);
}
