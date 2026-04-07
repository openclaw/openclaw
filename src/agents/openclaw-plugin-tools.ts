import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { applyPluginToolDeliveryDefaults } from "./plugin-tool-delivery-defaults.js";
import type { AnyAgentTool } from "./tools/common.js";

type ResolveOpenClawPluginToolsOptions = {
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
  allowGatewaySubagentBinding?: boolean;
  sandboxed?: boolean;
  agentSessionKey?: string;
  sessionId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  workspaceDir?: string;
  agentDir?: string;
  sandboxRoot?: string;
  modelHasVision?: boolean;
  modelProvider?: string;
  allowMediaInvokeCommands?: boolean;
  requesterAgentIdOverride?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  disablePluginTools?: boolean;
};

export function resolveOpenClawPluginToolsForOptions(params: {
  options?: ResolveOpenClawPluginToolsOptions;
  resolvedConfig?: OpenClawConfig;
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
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
      runtimeConfig: runtimeSnapshot?.config,
    }),
    existingToolNames: params.existingToolNames ?? new Set<string>(),
    toolAllowlist: params.options?.pluginToolAllowlist,
  });

  return applyPluginToolDeliveryDefaults({
    tools: pluginTools,
    deliveryContext,
  });
}
