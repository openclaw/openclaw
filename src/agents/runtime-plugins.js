import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";
export function ensureRuntimePluginsLoaded(params) {
    const workspaceDir = typeof params.workspaceDir === "string" && params.workspaceDir.trim()
        ? resolveUserPath(params.workspaceDir)
        : undefined;
    const allowGatewaySubagentBinding = params.allowGatewaySubagentBinding === true ||
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
