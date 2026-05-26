import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
//#region src/agents/identity.ts
const DEFAULT_ACK_REACTION = "👀";
function resolveAgentIdentity(cfg, agentId) {
	return resolveAgentConfig(cfg, agentId)?.identity;
}
function resolveAckReaction(cfg, agentId, opts) {
	if (opts?.channel && opts?.accountId) {
		const accountReaction = (getChannelConfig(cfg, opts.channel)?.accounts)?.[opts.accountId]?.ackReaction;
		if (accountReaction !== void 0) return accountReaction.trim();
	}
	if (opts?.channel) {
		const channelReaction = getChannelConfig(cfg, opts.channel)?.ackReaction;
		if (channelReaction !== void 0) return channelReaction.trim();
	}
	const configured = cfg.messages?.ackReaction;
	if (configured !== void 0) return configured.trim();
	return resolveAgentIdentity(cfg, agentId)?.emoji?.trim() || DEFAULT_ACK_REACTION;
}
function resolveIdentityNamePrefix(cfg, agentId) {
	const name = resolveAgentIdentity(cfg, agentId)?.name?.trim();
	if (!name) return;
	return `[${name}]`;
}
function resolveMessagePrefix(cfg, agentId, opts) {
	const configured = opts?.configured ?? cfg.messages?.messagePrefix;
	if (configured !== void 0) return configured;
	if (opts?.hasAllowFrom === true) return "";
	return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[openclaw]";
}
/** Helper to extract a channel config value by dynamic key. */
function getChannelConfig(cfg, channel) {
	const value = cfg.channels?.[channel];
	return typeof value === "object" && value !== null ? value : void 0;
}
function resolveResponsePrefix(cfg, agentId, opts) {
	if (opts?.channel && opts?.accountId) {
		const accountPrefix = (getChannelConfig(cfg, opts.channel)?.accounts)?.[opts.accountId]?.responsePrefix;
		if (accountPrefix !== void 0) {
			if (accountPrefix === "auto") return resolveIdentityNamePrefix(cfg, agentId);
			return accountPrefix;
		}
	}
	if (opts?.channel) {
		const channelPrefix = getChannelConfig(cfg, opts.channel)?.responsePrefix;
		if (channelPrefix !== void 0) {
			if (channelPrefix === "auto") return resolveIdentityNamePrefix(cfg, agentId);
			return channelPrefix;
		}
	}
	const configured = cfg.messages?.responsePrefix;
	if (configured !== void 0) {
		if (configured === "auto") return resolveIdentityNamePrefix(cfg, agentId);
		return configured;
	}
}
function resolveEffectiveMessagesConfig(cfg, agentId, opts) {
	return {
		messagePrefix: resolveMessagePrefix(cfg, agentId, {
			hasAllowFrom: opts?.hasAllowFrom,
			fallback: opts?.fallbackMessagePrefix
		}),
		responsePrefix: resolveResponsePrefix(cfg, agentId, {
			channel: opts?.channel,
			accountId: opts?.accountId
		})
	};
}
function resolveHumanDelayConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.humanDelay;
	const overrides = resolveAgentConfig(cfg, agentId)?.humanDelay;
	if (!defaults && !overrides) return;
	return {
		mode: overrides?.mode ?? defaults?.mode,
		minMs: overrides?.minMs ?? defaults?.minMs,
		maxMs: overrides?.maxMs ?? defaults?.maxMs
	};
}
//#endregion
export { resolveIdentityNamePrefix as a, resolveHumanDelayConfig as i, resolveAgentIdentity as n, resolveMessagePrefix as o, resolveEffectiveMessagesConfig as r, resolveResponsePrefix as s, resolveAckReaction as t };
