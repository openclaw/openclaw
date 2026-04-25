import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";

type RuntimePluginsLoadParams = {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
};

const log = createSubsystemLogger("agents/runtime-plugins");

export function ensureRuntimePluginsLoaded(params: RuntimePluginsLoadParams): void {
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

export function tryEnsureRuntimePluginsLoaded(params: RuntimePluginsLoadParams): boolean {
  try {
    ensureRuntimePluginsLoaded(params);
    return true;
  } catch (err) {
    log.warn("runtime plugin activation failed; continuing with current registry", {
      error: formatErrorMessage(err),
    });
    return false;
  }
}
