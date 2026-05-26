import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./paths-Cw7f9XhU.js";
import "./types.secrets-DwPik3M8.js";
import { u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { p as resolveThreadSessionKeys } from "./session-key-Bte0mmcq.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-CcqVVqEn.js";
import "./subsystem-DSPWLoK5.js";
import "./net-DCUMtgJy.js";
import { r as buildChatChannelMetaById } from "./chat-meta-2H4wOcrq.js";
import { o as emptyChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import "./typebox-CjEaoMel.js";
import "./common-E9YpX7pB.js";
import "./resolve-route-C8IahAyG.js";
import { t as buildAccountScopedDmSecurityPolicy } from "./helpers-CswdXPdi.js";
import { t as buildOutboundBaseSessionKey } from "./base-session-key-jTw5jqgt.js";
import "./delegate-CUgSnBCT.js";
import { r as createTopLevelChannelReplyToModeResolver, t as createScopedAccountReplyToModeResolver } from "./threading-helpers-JSVFlQzA.js";
import { t as normalizeOutboundThreadId } from "./thread-id-BtQMChxz.js";
import "./config-schema-DBTUnI0T.js";
import "./plugin-entry-Dgh5bRuw.js";
import "./setup-helpers-BC9z9VvG.js";
import "./secret-file-BmZ4BUYP.js";
import "./tailscale-status-zDpKLtE_.js";
import "./persistent-bindings.resolve-DrfbZLJ2.js";
//#region src/plugin-sdk/core.ts
function createInlineTextPairingAdapter(params) {
	return {
		idLabel: params.idLabel,
		normalizeAllowEntry: params.normalizeAllowEntry,
		notifyApproval: async (ctx) => {
			await params.notify({
				...ctx,
				message: params.message
			});
		}
	};
}
async function ensureConfiguredAcpBindingReady(params) {
	return (await import("./persistent-bindings.lifecycle-DF0v60tX.js")).ensureConfiguredAcpBindingReady(params);
}
let cachedSdkChatChannelMeta;
function resolveSdkChatChannelMeta(id) {
	const cacheKey = resolveBundledPluginsDir(process.env) ?? "";
	if (cachedSdkChatChannelMeta?.cacheKey !== cacheKey) cachedSdkChatChannelMeta = {
		cacheKey,
		metaById: buildChatChannelMetaById()
	};
	return cachedSdkChatChannelMeta.metaById[id];
}
function getChatChannelMeta(id) {
	return resolveSdkChatChannelMeta(id);
}
/** Remove one of the known provider prefixes from a free-form target string. */
function stripChannelTargetPrefix(raw, ...providers) {
	const trimmed = raw.trim();
	for (const provider of providers) {
		const prefix = `${normalizeLowercaseStringOrEmpty(provider)}:`;
		if (normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)) return trimmed.slice(prefix.length).trim();
	}
	return trimmed;
}
/** Remove generic target-kind prefixes such as `user:` or `group:`. */
function stripTargetKindPrefix(raw) {
	return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}
/**
* Build the canonical outbound session route payload returned by channel
* message adapters.
*/
function buildChannelOutboundSessionRoute(params) {
	const baseSessionKey = buildOutboundBaseSessionKey({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer
	});
	return {
		sessionKey: baseSessionKey,
		baseSessionKey,
		peer: params.peer,
		chatType: params.chatType,
		from: params.from,
		to: params.to,
		...params.threadId !== void 0 ? { threadId: params.threadId } : {}
	};
}
function recoverCurrentThreadSessionId(params) {
	const current = parseThreadSessionSuffix(params.currentSessionKey);
	if (!current.baseSessionKey || !current.threadId) return;
	if (normalizeOptionalLowercaseString(current.baseSessionKey) !== normalizeOptionalLowercaseString(params.route.baseSessionKey)) return;
	const context = {
		route: params.route,
		currentBaseSessionKey: current.baseSessionKey,
		currentThreadId: current.threadId
	};
	if (params.canRecover && !params.canRecover(context)) return;
	return current.threadId;
}
function buildThreadAwareOutboundSessionRoute(params) {
	const recoveredThreadId = recoverCurrentThreadSessionId({
		route: params.route,
		currentSessionKey: params.currentSessionKey,
		canRecover: params.canRecoverCurrentThread
	});
	const candidates = {
		replyToId: resolveThreadAwareOutboundCandidate(params.replyToId),
		threadId: resolveThreadAwareOutboundCandidate(params.threadId),
		currentSession: resolveThreadAwareOutboundCandidate(recoveredThreadId)
	};
	const candidate = (params.precedence ?? [
		"replyToId",
		"threadId",
		"currentSession"
	]).map((source) => candidates[source]).find(Boolean);
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey: params.route.baseSessionKey,
		threadId: candidate?.sessionThreadId,
		parentSessionKey: candidate ? params.parentSessionKey : void 0,
		useSuffix: params.useSuffix,
		normalizeThreadId: params.normalizeThreadId
	});
	return {
		...params.route,
		sessionKey: threadKeys.sessionKey,
		...candidate !== void 0 ? { threadId: candidate.routeThreadId } : {}
	};
}
function resolveThreadAwareOutboundCandidate(threadId) {
	const sessionThreadId = normalizeOutboundThreadId(threadId);
	if (sessionThreadId === void 0) return;
	return {
		routeThreadId: typeof threadId === "number" ? threadId : sessionThreadId,
		sessionThreadId
	};
}
/**
* Canonical entry helper for channel plugins.
*
* This wraps `definePluginEntry(...)`, registers the channel capability, and
* optionally exposes extra full-runtime registration such as tools or gateway
* handlers that only make sense outside setup-only registration modes.
*/
function defineChannelPluginEntry({ id, name, description, plugin, configSchema, setRuntime, registerCliMetadata, registerFull }) {
	return {
		id,
		name,
		description,
		configSchema: typeof configSchema === "function" ? configSchema() : configSchema ?? emptyChannelConfigSchema(),
		register(api) {
			if (api.registrationMode === "cli-metadata") {
				registerCliMetadata?.(api);
				return;
			}
			if (api.registrationMode === "tool-discovery") {
				registerFull?.(api);
				return;
			}
			api.registerChannel({ plugin });
			setRuntime?.(api.runtime);
			if (api.registrationMode === "discovery") {
				registerCliMetadata?.(api);
				return;
			}
			if (api.registrationMode !== "full") return;
			registerCliMetadata?.(api);
			registerFull?.(api);
		},
		channelPlugin: plugin,
		...setRuntime ? { setChannelRuntime: setRuntime } : {}
	};
}
/**
* Minimal setup-entry helper for channels that ship a separate `setup-entry.ts`.
*
* The setup entry only needs to export `{ plugin }`, but using this helper
* keeps the shape explicit in examples and generated typings.
*/
function defineSetupPluginEntry(plugin) {
	return { plugin };
}
function createInlineAttachedChannelResultAdapter(params) {
	return {
		sendText: params.sendText ? async (ctx) => ({
			channel: params.channel,
			...await params.sendText(ctx)
		}) : void 0,
		sendMedia: params.sendMedia ? async (ctx) => ({
			channel: params.channel,
			...await params.sendMedia(ctx)
		}) : void 0,
		sendPoll: params.sendPoll ? async (ctx) => ({
			channel: params.channel,
			...await params.sendPoll(ctx)
		}) : void 0
	};
}
function resolveChatChannelSecurity(security) {
	if (!security) return;
	if (!("dm" in security)) return security;
	return {
		resolveDmPolicy: ({ cfg, accountId, account }) => buildAccountScopedDmSecurityPolicy({
			cfg,
			channelKey: security.dm.channelKey,
			accountId,
			fallbackAccountId: security.dm.resolveFallbackAccountId?.(account) ?? account.accountId,
			policy: security.dm.resolvePolicy(account),
			allowFrom: security.dm.resolveAllowFrom(account) ?? [],
			defaultPolicy: security.dm.defaultPolicy,
			allowFromPathSuffix: security.dm.allowFromPathSuffix,
			policyPathSuffix: security.dm.policyPathSuffix,
			approveChannelId: security.dm.approveChannelId,
			approveHint: security.dm.approveHint,
			normalizeEntry: security.dm.normalizeEntry,
			inheritSharedDefaultsFromDefaultAccount: security.dm.inheritSharedDefaultsFromDefaultAccount
		}),
		...security.collectWarnings ? { collectWarnings: security.collectWarnings } : {},
		...security.collectAuditFindings ? { collectAuditFindings: security.collectAuditFindings } : {}
	};
}
function resolveChatChannelPairing(pairing) {
	if (!pairing) return;
	if (!("text" in pairing)) return pairing;
	return createInlineTextPairingAdapter(pairing.text);
}
function resolveChatChannelThreading(threading) {
	if (!threading) return;
	if (!("topLevelReplyToMode" in threading) && !("scopedAccountReplyToMode" in threading)) return threading;
	let resolveReplyToMode;
	if ("topLevelReplyToMode" in threading) resolveReplyToMode = createTopLevelChannelReplyToModeResolver(threading.topLevelReplyToMode);
	else resolveReplyToMode = createScopedAccountReplyToModeResolver(threading.scopedAccountReplyToMode);
	return {
		...threading,
		resolveReplyToMode
	};
}
function resolveChatChannelOutbound(outbound) {
	if (!outbound) return;
	if (!("attachedResults" in outbound)) return outbound;
	return {
		...outbound.base,
		...createInlineAttachedChannelResultAdapter(outbound.attachedResults)
	};
}
function createChatChannelPlugin(params) {
	return {
		...params.base,
		conversationBindings: {
			supportsCurrentConversationBinding: true,
			...params.base.conversationBindings
		},
		...params.security ? { security: resolveChatChannelSecurity(params.security) } : {},
		...params.pairing ? { pairing: resolveChatChannelPairing(params.pairing) } : {},
		...params.threading ? { threading: resolveChatChannelThreading(params.threading) } : {},
		...params.outbound ? { outbound: resolveChatChannelOutbound(params.outbound) } : {}
	};
}
function createChannelPluginBase(params) {
	return {
		id: params.id,
		meta: {
			...resolveSdkChatChannelMeta(params.id),
			...params.meta
		},
		...params.setupWizard ? { setupWizard: params.setupWizard } : {},
		...params.capabilities ? { capabilities: params.capabilities } : {},
		...params.commands ? { commands: params.commands } : {},
		...params.doctor ? { doctor: params.doctor } : {},
		...params.agentPrompt ? { agentPrompt: params.agentPrompt } : {},
		...params.streaming ? { streaming: params.streaming } : {},
		...params.reload ? { reload: params.reload } : {},
		...params.gatewayMethods ? { gatewayMethods: params.gatewayMethods } : {},
		...params.gatewayMethodDescriptors ? { gatewayMethodDescriptors: params.gatewayMethodDescriptors } : {},
		...params.configSchema ? { configSchema: params.configSchema } : {},
		...params.config ? { config: params.config } : {},
		...params.security ? { security: params.security } : {},
		...params.groups ? { groups: params.groups } : {},
		setup: params.setup
	};
}
//#endregion
export { defineChannelPluginEntry as a, getChatChannelMeta as c, stripTargetKindPrefix as d, createChatChannelPlugin as i, recoverCurrentThreadSessionId as l, buildThreadAwareOutboundSessionRoute as n, defineSetupPluginEntry as o, createChannelPluginBase as r, ensureConfiguredAcpBindingReady as s, buildChannelOutboundSessionRoute as t, stripChannelTargetPrefix as u };
