import { selectApplicableRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot } from "../config/runtime-snapshot.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { listProfilesForProvider } from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

type ResolveOpenClawPluginToolsOptions = OpenClawPluginToolOptions & {
  pluginToolAllowlist?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  sandboxRoot?: string;
  modelHasVision?: boolean;
  modelProvider?: string;
  allowMediaInvokeCommands?: boolean;
  requesterAgentIdOverride?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  disablePluginTools?: boolean;
  authProfileStore?: AuthProfileStore;
};

export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  if (params.options?.disablePluginTools) {
    return [];
  }

  const deliveryContext = normalizeDeliveryContext({
    channel: params.options?.agentChannel,
    to: params.options?.agentTo,
    accountId: params.options?.agentAccountId,
    threadId: params.options?.agentThreadId,
  });

  // Use config-only snapshot helpers for the one-shot runtimeConfig to avoid
  // expensive structuredClone of the full secrets runtime snapshot (see #76295).
  // Keep getRuntimeConfig as a live getter to observe runtime refreshes
  // (long-lived plugin tool callbacks depend on live refresh semantics).
  const runtimeConfig = selectApplicableRuntimeConfig({
    inputConfig: params.resolvedConfig ?? params.options?.config,
    runtimeConfig: getRuntimeConfigSnapshot() ?? undefined,
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot() ?? undefined,
  });
  const resolveCurrentRuntimeConfig = () => {
    const liveSnapshot = getActiveSecretsRuntimeSnapshot();
    return selectApplicableRuntimeConfig({
      inputConfig: params.resolvedConfig ?? params.options?.config,
      runtimeConfig: liveSnapshot?.config,
      runtimeSourceConfig: liveSnapshot?.sourceConfig,
    });
  };
  const authProfileStore = params.options?.authProfileStore;
  const pluginTools = resolvePluginTools({
    ...resolveOpenClawPluginToolInputs({
      options: params.options,
      resolvedConfig: params.resolvedConfig,
      runtimeConfig,
      getRuntimeConfig: resolveCurrentRuntimeConfig,
    }),
    existingToolNames: params.existingToolNames ?? new Set<string>(),
    toolAllowlist: params.options?.pluginToolAllowlist,
    allowGatewaySubagentBinding: params.options?.allowGatewaySubagentBinding,
    ...(authProfileStore
      ? {
          hasAuthForProvider: (providerId) =>
            listProfilesForProvider(authProfileStore, providerId).length > 0,
        }
      : {}),
  });

  return applyPluginToolDeliveryDefaults({
    tools: pluginTools,
    deliveryContext,
  });
}
