import { resolveAgentConfig } from "./agent-scope.js";
const DEFAULT_ACK_REACTION = "👀";
export function resolveAgentIdentity(cfg, agentId) {
    return resolveAgentConfig(cfg, agentId)?.identity;
}
export function resolveAckReaction(cfg, agentId, opts) {
    // L1: Channel account level
    if (opts?.channel && opts?.accountId) {
        const channelCfg = getChannelConfig(cfg, opts.channel);
        const accounts = channelCfg?.accounts;
        const accountReaction = accounts?.[opts.accountId]?.ackReaction;
        if (accountReaction !== undefined) {
            return accountReaction.trim();
        }
    }
    // L2: Channel level
    if (opts?.channel) {
        const channelCfg = getChannelConfig(cfg, opts.channel);
        const channelReaction = channelCfg?.ackReaction;
        if (channelReaction !== undefined) {
            return channelReaction.trim();
        }
    }
    // L3: Global messages level
    const configured = cfg.messages?.ackReaction;
    if (configured !== undefined) {
        return configured.trim();
    }
    // L4: Agent identity emoji fallback
    const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
    return emoji || DEFAULT_ACK_REACTION;
}
export function resolveIdentityNamePrefix(cfg, agentId) {
    const name = resolveAgentIdentity(cfg, agentId)?.name?.trim();
    if (!name) {
        return undefined;
    }
    return `[${name}]`;
}
/** Returns just the identity name (without brackets) for template context. */
export function resolveIdentityName(cfg, agentId) {
    return resolveAgentIdentity(cfg, agentId)?.name?.trim() || undefined;
}
export function resolveMessagePrefix(cfg, agentId, opts) {
    const configured = opts?.configured ?? cfg.messages?.messagePrefix;
    if (configured !== undefined) {
        return configured;
    }
    const hasAllowFrom = opts?.hasAllowFrom === true;
    if (hasAllowFrom) {
        return "";
    }
    return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[openclaw]";
}
/** Helper to extract a channel config value by dynamic key. */
function getChannelConfig(cfg, channel) {
    const channels = cfg.channels;
    const value = channels?.[channel];
    return typeof value === "object" && value !== null
        ? value
        : undefined;
}
export function resolveResponsePrefix(cfg, agentId, opts) {
    // L1: Channel account level
    if (opts?.channel && opts?.accountId) {
        const channelCfg = getChannelConfig(cfg, opts.channel);
        const accounts = channelCfg?.accounts;
        const accountPrefix = accounts?.[opts.accountId]?.responsePrefix;
        if (accountPrefix !== undefined) {
            if (accountPrefix === "auto") {
                return resolveIdentityNamePrefix(cfg, agentId);
            }
            return accountPrefix;
        }
    }
    // L2: Channel level
    if (opts?.channel) {
        const channelCfg = getChannelConfig(cfg, opts.channel);
        const channelPrefix = channelCfg?.responsePrefix;
        if (channelPrefix !== undefined) {
            if (channelPrefix === "auto") {
                return resolveIdentityNamePrefix(cfg, agentId);
            }
            return channelPrefix;
        }
    }
    // L4: Global level
    const configured = cfg.messages?.responsePrefix;
    if (configured !== undefined) {
        if (configured === "auto") {
            return resolveIdentityNamePrefix(cfg, agentId);
        }
        return configured;
    }
    return undefined;
}
export function resolveEffectiveMessagesConfig(cfg, agentId, opts) {
    return {
        messagePrefix: resolveMessagePrefix(cfg, agentId, {
            hasAllowFrom: opts?.hasAllowFrom,
            fallback: opts?.fallbackMessagePrefix,
        }),
        responsePrefix: resolveResponsePrefix(cfg, agentId, {
            channel: opts?.channel,
            accountId: opts?.accountId,
        }),
    };
}
export function resolveHumanDelayConfig(cfg, agentId) {
    const defaults = cfg.agents?.defaults?.humanDelay;
    const overrides = resolveAgentConfig(cfg, agentId)?.humanDelay;
    if (!defaults && !overrides) {
        return undefined;
    }
    return {
        mode: overrides?.mode ?? defaults?.mode,
        minMs: overrides?.minMs ?? defaults?.minMs,
        maxMs: overrides?.maxMs ?? defaults?.maxMs,
    };
}
