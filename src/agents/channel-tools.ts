import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import {
  createMessageActionDiscoveryContext,
  resolveMessageActionDiscoveryForPlugin,
  resolveMessageActionDiscoveryChannelId,
  __testing as messageActionTesting,
} from "../channels/plugins/message-action-discovery.js";
import type { ChannelAgentTool, ChannelMessageActionName } from "../channels/plugins/types.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";

type ChannelAgentToolMeta = {
  channelId: string;
};

const channelAgentToolMeta = new WeakMap<ChannelAgentTool, ChannelAgentToolMeta>();

export function getChannelAgentToolMeta(tool: ChannelAgentTool): ChannelAgentToolMeta | undefined {
  return channelAgentToolMeta.get(tool);
}

export function copyChannelAgentToolMeta(source: ChannelAgentTool, target: ChannelAgentTool): void {
  const meta = channelAgentToolMeta.get(source);
  if (meta) {
    channelAgentToolMeta.set(target, meta);
  }
}

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions) {
    return [];
  }
  return resolveMessageActionDiscoveryForPlugin({
    pluginId: plugin.id,
    actions: plugin.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
  }).actions;
}

/**
 * Get the list of all supported message actions across all configured channels.
 */
export function listAllChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  for (const plugin of listChannelPlugins()) {
    const channelActions = resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: createMessageActionDiscoveryContext({
        ...params,
        currentChannelProvider: plugin.id,
      }),
      includeActions: true,
    }).actions;
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * List cross-channel actions from plugins OTHER than the excluded channel.
 * Used to surface actions like x-post or x-quote that can be invoked from
 * any channel and auto-routed to the owning plugin.
 */
export function listCrossChannelActions(params: {
  cfg?: OpenClawConfig;
  excludeChannel: string;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  for (const plugin of listChannelPlugins()) {
    if (plugin.id === params.excludeChannel) {
      continue;
    }
    if (!plugin.actions) {
      continue;
    }
    const channelActions = resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: createMessageActionDiscoveryContext({
        cfg: params.cfg,
        currentChannelProvider: plugin.id,
      }),
      includeActions: true,
    }).actions;
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * Resolve the channel that owns a given action.
 * Returns the channel ID if exactly one loaded plugin claims the action, otherwise undefined.
 * Used to route cross-channel actions (e.g. x-post from Feishu -> "x").
 */
export function resolveActionOwningChannel(params: {
  action: string;
  currentChannel?: string;
  cfg?: OpenClawConfig;
}): string | undefined {
  for (const plugin of listChannelPlugins()) {
    if (plugin.id === params.currentChannel) {
      continue;
    }
    if (!plugin.actions) {
      continue;
    }
    const channelActions = resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: createMessageActionDiscoveryContext({
        cfg: params.cfg,
        currentChannelProvider: plugin.id,
      }),
      includeActions: true,
    }).actions;
    if (channelActions.includes(params.action as ChannelMessageActionName)) {
      return plugin.id;
    }
  }
  return undefined;
}

export function listChannelAgentTools(params: { cfg?: OpenClawConfig }): ChannelAgentTool[] {
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) {
      continue;
    }
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) {
      for (const tool of resolved) {
        channelAgentToolMeta.set(tool, { channelId: plugin.id });
      }
      tools.push(...resolved);
    }
  }
  return tools;
}

export function resolveChannelMessageToolHints(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  const hints: string[] = [];
  const channelId = normalizeAnyChannelId(params.channel);

  // Current channel hints
  if (channelId) {
    const plugin = getChannelPlugin(channelId);
    const resolve = plugin?.agentPrompt?.messageToolHints;
    if (resolve) {
      const resolved = (resolve({ cfg, accountId: params.accountId }) ?? [])
        .map((entry: string) => entry.trim())
        .filter(Boolean);
      hints.push(...resolved);
    }
  }

  // Cross-channel hints: include messageToolHints from other loaded plugins
  // that have registered actions (e.g. X plugin providing x-* action hints).
  for (const plugin of listChannelPlugins()) {
    if (!plugin.agentPrompt?.messageToolHints) {
      continue;
    }
    if (channelId && plugin.id === channelId) {
      continue;
    }
    if (!plugin.actions) {
      continue;
    }
    const pluginHints = (plugin.agentPrompt.messageToolHints({ cfg, accountId: null }) ?? [])
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    hints.push(...pluginHints);
  }

  return hints;
}

export const __testing = {
  resetLoggedListActionErrors() {
    messageActionTesting.resetLoggedMessageActionErrors();
  },
};
