import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { createMessageActionDiscoveryContext, resolveMessageActionDiscoveryForPlugin, resolveMessageActionDiscoveryChannelId, resolveCurrentChannelMessageToolDiscoveryAdapter, __testing as messageActionTesting, } from "../channels/plugins/message-action-discovery.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
const channelAgentToolMeta = new WeakMap();
export function getChannelAgentToolMeta(tool) {
    return channelAgentToolMeta.get(tool);
}
export function copyChannelAgentToolMeta(source, target) {
    const meta = channelAgentToolMeta.get(source);
    if (meta) {
        channelAgentToolMeta.set(target, meta);
    }
}
/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(params) {
    const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
    if (!channelId) {
        return [];
    }
    const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
    if (!pluginActions?.actions) {
        return [];
    }
    return resolveMessageActionDiscoveryForPlugin({
        pluginId: pluginActions.pluginId,
        actions: pluginActions.actions,
        context: createMessageActionDiscoveryContext(params),
        includeActions: true,
    }).actions;
}
/**
 * Get the list of all supported message actions across all configured channels.
 */
export function listAllChannelSupportedActions(params) {
    const actions = new Set();
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
export function listChannelAgentTools(params) {
    // Channel docking: aggregate channel-owned tools (login, etc.).
    const tools = [];
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
export function resolveChannelMessageToolHints(params) {
    const channelId = normalizeAnyChannelId(params.channel);
    if (!channelId) {
        return [];
    }
    const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolHints;
    if (!resolve) {
        return [];
    }
    const cfg = params.cfg ?? {};
    return (resolve({ cfg, accountId: params.accountId }) ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean);
}
export function resolveChannelMessageToolCapabilities(params) {
    const channelId = normalizeAnyChannelId(params.channel);
    if (!channelId) {
        return [];
    }
    const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolCapabilities;
    if (!resolve) {
        return [];
    }
    const cfg = params.cfg ?? {};
    return (resolve({ cfg, accountId: params.accountId }) ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean);
}
export function resolveChannelReactionGuidance(params) {
    const channelId = normalizeAnyChannelId(params.channel);
    if (!channelId) {
        return undefined;
    }
    const resolve = getChannelPlugin(channelId)?.agentPrompt?.reactionGuidance;
    if (!resolve) {
        return undefined;
    }
    const cfg = params.cfg ?? {};
    const resolved = resolve({ cfg, accountId: params.accountId });
    if (!resolved?.level) {
        return undefined;
    }
    return {
        level: resolved.level,
        channel: resolved.channelLabel?.trim() || channelId,
    };
}
export const __testing = {
    resetLoggedListActionErrors() {
        messageActionTesting.resetLoggedMessageActionErrors();
    },
};
