import type { OpenClawConfig } from "../config/config.js";
import { getGlobalHookRunner, initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const loadOptions = {
    config: params.config,
    workspaceDir,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  const registry = resolveRuntimePluginRegistry(loadOptions);
  if (registry && !getGlobalHookRunner()) {
    // Runtime/plugin helper callers can load a compatible registry snapshot without
    // activating the global hook runner (for example in embedded-runner-only flows).
    // Ensure hooks like agent_end are available once a registry exists.
    initializeGlobalHookRunner(registry);
  }
}
