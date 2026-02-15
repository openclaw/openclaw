import type {
  ChannelAgentTool,
  ChannelMessageActionName,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { getChannelDock } from "../channels/dock.js";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import { defaultRuntime } from "../runtime.js";

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
  channel?: string;
}): ChannelMessageActionName[] {
  if (!params.channel) {
    return [];
  }
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions?.listActions) {
    return [];
  }
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  return runPluginListActions(plugin, cfg);
}

/**
 * Get the list of all supported message actions across all configured channels.
 */
export function listAllChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions?.listActions) {
      continue;
    }
    const cfg = params.cfg ?? ({} as OpenClawConfig);
    const channelActions = runPluginListActions(plugin, cfg);
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * Get actions from plugins OTHER than the specified channel.
 * Used to build the "cross-channel actions" section in the message tool description.
 */
export function listCrossChannelActions(params: {
  cfg?: OpenClawConfig;
  excludeChannel: string;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  for (const plugin of listChannelPlugins()) {
    if (plugin.id === params.excludeChannel) {
      continue;
    }
    if (!plugin.actions?.listActions) {
      continue;
    }
    const channelActions = runPluginListActions(plugin, cfg);
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * Resolve the channel that owns a given action.
 * Returns the channel ID if exactly one loaded plugin claims the action, otherwise undefined.
 * Used to route cross-channel actions (e.g. x-post from Feishu → "x").
 */
export function resolveActionOwningChannel(params: {
  action: string;
  currentChannel?: string;
  cfg?: OpenClawConfig;
}): string | undefined {
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  for (const plugin of listChannelPlugins()) {
    if (plugin.id === params.currentChannel) {
      continue;
    }
    if (!plugin.actions?.listActions) {
      continue;
    }
    const actions = runPluginListActions(plugin, cfg);
    if (actions.includes(params.action as ChannelMessageActionName)) {
      return plugin.id;
    }
  }
  return undefined;
}

export function listChannelAgentTools(params: { cfg?: OpenClawConfig }): ChannelAgentTool[] {
  // Channel docking: aggregate channel-owned tools (login, etc.).
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) {
      continue;
    }
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) {
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
    const dock = getChannelDock(channelId);
    const resolve = dock?.agentPrompt?.messageToolHints;
    if (resolve) {
      const resolved = (resolve({ cfg, accountId: params.accountId }) ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean);
      hints.push(...resolved);
    }
  }

  // Cross-channel hints: include messageToolHints from other loaded plugins
  // that have registered actions (e.g. X plugin providing x-* action hints).
  // This ensures the model knows about cross-channel capabilities.
  for (const plugin of listChannelPlugins()) {
    if (!plugin.agentPrompt?.messageToolHints) {
      continue;
    }
    // Skip the current channel (already resolved above)
    if (channelId && plugin.id === channelId) {
      continue;
    }
    // Only include if the plugin has actions (i.e. it provides cross-channel operations)
    if (!plugin.actions?.listActions) {
      continue;
    }
    const pluginHints = (plugin.agentPrompt.messageToolHints({ cfg, accountId: null }) ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean);
    hints.push(...pluginHints);
  }

  return hints;
}

const loggedListActionErrors = new Set<string>();

function runPluginListActions(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
): ChannelMessageActionName[] {
  if (!plugin.actions?.listActions) {
    return [];
  }
  try {
    const listed = plugin.actions.listActions({ cfg });
    return Array.isArray(listed) ? listed : [];
  } catch (err) {
    logListActionsError(plugin.id, err);
    return [];
  }
}

function logListActionsError(pluginId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const key = `${pluginId}:${message}`;
  if (loggedListActionErrors.has(key)) {
    return;
  }
  loggedListActionErrors.add(key);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  const details = stack ?? message;
  defaultRuntime.error?.(`[channel-tools] ${pluginId}.actions.listActions failed: ${details}`);
}

export const __testing = {
  resetLoggedListActionErrors() {
    loggedListActionErrors.clear();
  },
};
