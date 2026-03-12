import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { i as resolveAgentConfig } from "./agent-scope-C2k6BQnt.js";

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
/** Returns just the identity name (without brackets) for template context. */
function resolveIdentityName(cfg, agentId) {
	return resolveAgentIdentity(cfg, agentId)?.name?.trim() || void 0;
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
//#region src/auto-reply/reply/response-prefix-template.ts
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
/**
* Interpolate template variables in a response prefix string.
*
* @param template - The template string with `{variable}` placeholders
* @param context - Context object with values for interpolation
* @returns The interpolated string, or undefined if template is undefined
*
* @example
* resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
*   model: "gpt-5.2",
*   thinkingLevel: "high"
* })
* // Returns: "[gpt-5.2 | think:high]"
*/
function resolveResponsePrefixTemplate(template, context) {
	if (!template) return;
	return template.replace(TEMPLATE_VAR_PATTERN, (match, varName) => {
		switch (varName.toLowerCase()) {
			case "model": return context.model ?? match;
			case "modelfull": return context.modelFull ?? match;
			case "provider": return context.provider ?? match;
			case "thinkinglevel":
			case "think": return context.thinkingLevel ?? match;
			case "identity.name":
			case "identityname": return context.identityName ?? match;
			default: return match;
		}
	});
}
/**
* Extract short model name from a full model string.
*
* Strips:
* - Provider prefix (e.g., "openai/" from "openai/gpt-5.2")
* - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
* - Common version suffixes (e.g., "-latest")
*
* @example
* extractShortModelName("openai-codex/gpt-5.2") // "gpt-5.2"
* extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
* extractShortModelName("gpt-5.2-latest") // "gpt-5.2"
*/
function extractShortModelName(fullModel) {
	const slash = fullModel.lastIndexOf("/");
	return (slash >= 0 ? fullModel.slice(slash + 1) : fullModel).replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

//#endregion
//#region src/channels/reply-prefix.ts
var reply_prefix_exports = /* @__PURE__ */ __exportAll({
	createReplyPrefixContext: () => createReplyPrefixContext,
	createReplyPrefixOptions: () => createReplyPrefixOptions
});
function createReplyPrefixContext(params) {
	const { cfg, agentId } = params;
	const prefixContext = { identityName: resolveIdentityName(cfg, agentId) };
	const onModelSelected = (ctx) => {
		prefixContext.provider = ctx.provider;
		prefixContext.model = extractShortModelName(ctx.model);
		prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
		prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
	};
	return {
		prefixContext,
		responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
			channel: params.channel,
			accountId: params.accountId
		}).responsePrefix,
		responsePrefixContextProvider: () => prefixContext,
		onModelSelected
	};
}
function createReplyPrefixOptions(params) {
	const { responsePrefix, responsePrefixContextProvider, onModelSelected } = createReplyPrefixContext(params);
	return {
		responsePrefix,
		responsePrefixContextProvider,
		onModelSelected
	};
}

//#endregion
export { resolveAgentIdentity as a, resolveIdentityNamePrefix as c, resolveAckReaction as i, resolveMessagePrefix as l, reply_prefix_exports as n, resolveEffectiveMessagesConfig as o, resolveResponsePrefixTemplate as r, resolveHumanDelayConfig as s, createReplyPrefixOptions as t };