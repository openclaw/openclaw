import { selectApplicableRuntimeConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveOpenClawPluginToolInputs, } from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
export function resolveOpenClawPluginToolsForOptions(params) {
    if (params.options?.disablePluginTools) {
        return [];
    }
    const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
    const deliveryContext = normalizeDeliveryContext({
        channel: params.options?.agentChannel,
        to: params.options?.agentTo,
        accountId: params.options?.agentAccountId,
        threadId: params.options?.agentThreadId,
    });
    const pluginTools = resolvePluginTools({
        ...resolveOpenClawPluginToolInputs({
            options: params.options,
            resolvedConfig: params.resolvedConfig,
            runtimeConfig: selectApplicableRuntimeConfig({
                inputConfig: params.resolvedConfig ?? params.options?.config,
                runtimeConfig: runtimeSnapshot?.config,
                runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
            }),
        }),
        existingToolNames: params.existingToolNames ?? new Set(),
        toolAllowlist: params.options?.pluginToolAllowlist,
    });
    return applyPluginToolDeliveryDefaults({
        tools: pluginTools,
        deliveryContext,
    });
}
