import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
import { p as resolveSessionAgentId } from "./agent-scope-CcybJBoN.js";
import { r as normalizeChatChannelId } from "./ids-PHiL43bp.js";
import "./registry-DCDeYWxU.js";
import "./message-channel-core-CFCQaimB.js";
import { u as normalizeMessageChannel } from "./message-channel-V4touQJP.js";
import { n as getBundledChannelPlugin } from "./bundled-YTjj9IOu.js";
import { a as normalizeChannelId, n as getLoadedChannelPlugin } from "./registry-sLSHLMDf.js";
import "./plugins-BEXErCqt.js";
import { r as isSilentReplyPayloadText } from "./tokens-DQI2KUQE.js";
import { a as hasReplyPayloadContent } from "./payload-B-LeE4TP.js";
import { c as shouldSuppressReasoningPayload, o as formatBtwTextForExternalDelivery, t as resolveSilentReplyPolicy } from "./silent-reply-Bup4vWvY.js";
import { t as buildOutboundSessionContext } from "./session-context-DuYrMSS-.js";
import { r as resolveEffectiveMessagesConfig } from "./identity-GoxySUrw.js";
import { t as normalizeReplyPayload } from "./normalize-reply-EQi401n0.js";
//#region src/auto-reply/reply/route-reply.ts
/**
* Provider-agnostic reply router.
*
* Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
* instead of using the session's lastChannel. This ensures replies go back to the
* provider where the message originated, even when the main session is shared
* across multiple providers.
*/
const deliverRuntimeLoader = createLazyImportLoader(() => import("./deliver-runtime-BK8nF47j.js"));
function loadDeliverRuntime() {
	return deliverRuntimeLoader.load();
}
/**
* Routes a reply payload to the specified channel.
*
* This function provides a unified interface for sending messages to any
* supported provider. It's used by the followup queue to route replies
* back to the originating channel when OriginatingChannel/OriginatingTo
* are set.
*/
async function routeReply(params) {
	const { payload, channel, to, accountId, threadId, cfg, abortSignal } = params;
	if (shouldSuppressReasoningPayload(payload)) return { ok: true };
	const normalizedChannel = normalizeMessageChannel(channel);
	const channelId = normalizeChannelId(channel) ?? normalizeOptionalLowercaseString(channel) ?? null;
	const loadedPlugin = channelId ? getLoadedChannelPlugin(channelId) : void 0;
	const bundledPlugin = channelId && !loadedPlugin ? getBundledChannelPlugin(channelId) : void 0;
	const messaging = loadedPlugin?.messaging ?? bundledPlugin?.messaging;
	const threading = loadedPlugin?.threading ?? bundledPlugin?.threading;
	const resolvedAgentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: cfg
	}) : void 0;
	const responsePrefix = params.sessionKey ? resolveEffectiveMessagesConfig(cfg, resolvedAgentId ?? resolveSessionAgentId({ config: cfg }), {
		channel: normalizedChannel,
		accountId
	}).responsePrefix : cfg.messages?.responsePrefix === "auto" ? void 0 : cfg.messages?.responsePrefix;
	const policySessionKey = params.policySessionKey ?? params.sessionKey;
	const normalized = isSilentReplyPayloadText(payload.text) && resolveSilentReplyPolicy({
		cfg,
		sessionKey: policySessionKey,
		surface: channelId ?? String(channel),
		conversationType: params.policyConversationType
	}) !== "allow" ? {
		...payload,
		text: payload.text?.trim() || "NO_REPLY"
	} : normalizeReplyPayload(payload, {
		responsePrefix,
		transformReplyPayload: messaging?.transformReplyPayload ? (nextPayload) => messaging.transformReplyPayload?.({
			payload: nextPayload,
			cfg,
			accountId
		}) ?? nextPayload : void 0
	});
	if (!normalized) return { ok: true };
	const externalPayload = {
		...normalized,
		text: formatBtwTextForExternalDelivery(normalized)
	};
	let text = externalPayload.text ?? "";
	let mediaUrls = (externalPayload.mediaUrls?.filter(Boolean) ?? []).length ? externalPayload.mediaUrls?.filter(Boolean) : externalPayload.mediaUrl ? [externalPayload.mediaUrl] : [];
	const replyToId = externalPayload.replyToId;
	const hasChannelData = messaging?.hasStructuredReplyPayload?.({ payload: externalPayload });
	if (!hasReplyPayloadContent({
		...externalPayload,
		text,
		mediaUrls
	}, { hasChannelData })) return { ok: true };
	if (channel === "webchat") return {
		ok: false,
		error: "Webchat routing not supported for queued replies"
	};
	if (!channelId) return {
		ok: false,
		error: `Unknown channel: ${String(channel)}`
	};
	if (abortSignal?.aborted) return {
		ok: false,
		error: "Reply routing aborted"
	};
	const replyTransport = threading?.resolveReplyTransport?.({
		cfg,
		accountId,
		threadId,
		replyToId
	}) ?? null;
	const resolvedReplyToId = replyTransport?.replyToId ?? replyToId ?? void 0;
	const resolvedThreadId = replyTransport && Object.hasOwn(replyTransport, "threadId") ? replyTransport.threadId ?? null : threadId ?? null;
	try {
		const { deliverOutboundPayloads } = await loadDeliverRuntime();
		const outboundSession = buildOutboundSessionContext({
			cfg,
			agentId: resolvedAgentId,
			sessionKey: params.sessionKey,
			policySessionKey: params.policySessionKey,
			conversationType: params.policyConversationType,
			isGroup: params.policySessionKey || params.policyConversationType ? void 0 : params.isGroup,
			requesterSenderId: params.requesterSenderId,
			requesterSenderName: params.requesterSenderName,
			requesterSenderUsername: params.requesterSenderUsername,
			requesterSenderE164: params.requesterSenderE164
		});
		return {
			ok: true,
			messageId: (await deliverOutboundPayloads({
				cfg,
				channel: channelId,
				to,
				accountId: accountId ?? void 0,
				payloads: [externalPayload],
				replyToId: resolvedReplyToId ?? null,
				threadId: resolvedThreadId,
				session: outboundSession,
				abortSignal,
				mirror: params.mirror !== false && params.sessionKey ? {
					sessionKey: params.sessionKey,
					agentId: resolvedAgentId,
					text,
					mediaUrls,
					...params.isGroup != null ? { isGroup: params.isGroup } : {},
					...params.groupId ? { groupId: params.groupId } : {}
				} : void 0
			})).at(-1)?.messageId
		};
	} catch (err) {
		return {
			ok: false,
			error: `Failed to route reply to ${channel}: ${formatErrorMessage(err)}`
		};
	}
}
/**
* Checks if a channel type is routable via routeReply.
*
* Some channels (webchat) require special handling and cannot be routed through
* this generic interface.
*/
function isRoutableChannel(channel) {
	if (!channel || channel === "webchat") return false;
	return normalizeChatChannelId(channel) !== null || normalizeChannelId(channel) !== null;
}
//#endregion
export { routeReply as n, isRoutableChannel as t };
