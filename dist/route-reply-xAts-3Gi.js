import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import "./registry-CtWyD2pE.js";
import "./message-channel-core-BoUoCGOD.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { r as getBundledChannelPlugin } from "./bundled-0oTAwz0N.js";
import { a as normalizeChannelId, n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { a as hasReplyPayloadContent } from "./payload-BDV15CYA.js";
import { r as resolveEffectiveMessagesConfig } from "./identity-nYw-h8DL.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as normalizeReplyPayload } from "./normalize-reply-yKKEXSMw.js";
import { a as shouldSuppressReasoningPayload, r as formatBtwTextForExternalDelivery } from "./reply-payloads-MDazU9oj.js";
//#region src/auto-reply/reply/route-reply.ts
/**
* Provider-agnostic reply router.
*
* Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
* instead of using the session's lastChannel. This ensures replies go back to the
* provider where the message originated, even when the main session is shared
* across multiple providers.
*/
const messageRuntimeLoader = createLazyImportLoader(() => import("./runtime-DpGOQShF.js"));
function loadDeliverRuntime() {
	return messageRuntimeLoader.load();
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
	const normalized = normalizeReplyPayload(payload, {
		responsePrefix: params.sessionKey ? resolveEffectiveMessagesConfig(cfg, resolvedAgentId ?? resolveSessionAgentId({ config: cfg }), {
			channel: normalizedChannel,
			accountId
		}).responsePrefix : cfg.messages?.responsePrefix === "auto" ? void 0 : cfg.messages?.responsePrefix,
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
	let mediaUrls = [];
	for (const url of externalPayload.mediaUrls ?? []) if (url) mediaUrls.push(url);
	if (mediaUrls.length === 0 && externalPayload.mediaUrl) mediaUrls = [externalPayload.mediaUrl];
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
		const { sendDurableMessageBatch } = await loadDeliverRuntime();
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
		const send = await sendDurableMessageBatch({
			cfg,
			channel: channelId,
			to,
			accountId: accountId ?? void 0,
			payloads: [externalPayload],
			replyToId: resolvedReplyToId ?? null,
			threadId: resolvedThreadId,
			session: outboundSession,
			signal: abortSignal,
			mirror: params.mirror !== false && params.sessionKey ? {
				sessionKey: params.sessionKey,
				agentId: resolvedAgentId,
				text,
				mediaUrls,
				...params.isGroup != null ? { isGroup: params.isGroup } : {},
				...params.groupId ? { groupId: params.groupId } : {}
			} : void 0
		});
		if (send.status === "failed" || send.status === "partial_failed") throw send.error;
		return {
			ok: true,
			messageId: (send.status === "sent" ? send.results : []).at(-1)?.messageId
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
