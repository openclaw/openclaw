import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

export function shouldSkipRuntimePluginLoadForCoordinationOnly(params: {
  commandName?: string;
  effectiveToolPolicy?: string;
}): boolean {
  return params.commandName === "agent-exec" && params.effectiveToolPolicy === "coordination_only";
}

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
  commandName?: string;
  effectiveToolPolicy?: string;
}): void {
  if (shouldSkipRuntimePluginLoadForCoordinationOnly(params)) {
    return;
  }

  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const loadOptions = {
    config: params.config,
    workspaceDir,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  resolveRuntimePluginRegistry(loadOptions);
}
