import { l as recordInboundSessionAndDispatchReply } from "./inbound-reply-dispatch-Bi01ox5N.js";
import { r as resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope-DF4N8x5q.js";
import "./direct-dm-access-BBIpNsk-.js";
//#region src/plugin-sdk/direct-dm.ts
/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
async function dispatchInboundDirectDmWithRuntime(params) {
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		peer: params.peer,
		runtime: params.runtime.channel,
		sessionStore: params.cfg.session?.store
	});
	const { storePath, body } = buildEnvelope({
		channel: params.channelLabel,
		from: params.conversationLabel,
		body: params.rawBody,
		timestamp: params.timestamp
	});
	const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: params.bodyForAgent ?? params.rawBody,
		RawBody: params.rawBody,
		CommandBody: params.commandBody ?? params.rawBody,
		From: params.senderAddress,
		To: params.recipientAddress,
		SessionKey: route.sessionKey,
		AccountId: route.accountId ?? params.accountId,
		ChatType: "direct",
		ConversationLabel: params.conversationLabel,
		SenderId: params.senderId,
		Provider: params.provider ?? params.channel,
		Surface: params.surface ?? params.channel,
		MessageSid: params.messageId,
		MessageSidFull: params.messageId,
		Timestamp: params.timestamp,
		CommandAuthorized: params.commandAuthorized,
		OriginatingChannel: params.originatingChannel ?? params.channel,
		OriginatingTo: params.originatingTo ?? params.recipientAddress,
		...params.extraContext
	});
	await recordInboundSessionAndDispatchReply({
		cfg: params.cfg,
		channel: params.channel,
		accountId: route.accountId ?? params.accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: params.runtime.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		deliver: params.deliver,
		onRecordError: params.onRecordError,
		onDispatchError: params.onDispatchError
	});
	return {
		route,
		storePath,
		ctxPayload
	};
}
//#endregion
export { dispatchInboundDirectDmWithRuntime as t };
