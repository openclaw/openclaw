import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  // Fast path: if the active plugin registry is already populated (the boot
  // path ran `loadGatewayPlugins`), the function's intent — "ensure runtime
  // plugins are loaded" — is already satisfied. Skip rebuilding load options
  // and re-asking the loader.
  //
  // Without this short-circuit, every inbound dispatch hits
  // `resolveRuntimePluginRegistry` with a 3-field options set
  // (`config`, `workspaceDir`, `runtimeOptions`), which derives a different
  // `cacheKey` than boot's 9+ field set (which includes `onlyPluginIds`,
  // `activationSourceConfig`, `autoEnabledReasons`, etc.).
  // `getCompatibleActivePluginRegistry`'s strict `cacheKey` equality fails;
  // the call falls through to a full `loadOpenClawPlugins`, re-imports every
  // plugin, and re-runs each plugin's `register()` — ~5–6s per inbound
  // message on hosted gateways. The rebuild is wasted because the active
  // registry is already a valid answer.
  //
  // Plugin reconfiguration (`installs`/`uninstalls`/auto-enable changes)
  // already invalidates the active registry through other code paths
  // (`setActivePluginRegistry`, gateway restart on config write), so a stale
  // active registry is not a concern here.
  if (getActivePluginRegistry()) {
    return;
  }
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const loadOptions = {
    config: params.config,
    workspaceDir,
    runtimeOptions: allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  resolveRuntimePluginRegistry(loadOptions);
}
