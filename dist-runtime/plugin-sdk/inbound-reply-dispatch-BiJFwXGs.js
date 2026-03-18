import { bn as dispatchReplyFromConfig, vn as withReplyDispatcher } from "./setup-wizard-helpers-BPw-E_P4.js";
import { n as createReplyPrefixOptions } from "./reply-prefix-Dcd4HlHm.js";
import { t as createNormalizedOutboundDeliverer } from "./reply-payload-4ACAf9Rp.js";
//#region src/plugin-sdk/inbound-reply-dispatch.ts
/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
async function dispatchReplyFromConfigWithSettledDispatcher(params) {
	return await withReplyDispatcher({
		dispatcher: params.dispatcher,
		onSettled: params.onSettled,
		run: () => dispatchReplyFromConfig({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions
		})
	});
}
/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
function buildInboundReplyDispatchBase(params) {
	return {
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		agentId: params.route.agentId,
		routeSessionKey: params.route.sessionKey,
		storePath: params.storePath,
		ctxPayload: params.ctxPayload,
		recordInboundSession: params.core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher: params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher
	};
}
/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
async function dispatchInboundReplyWithBase(params) {
	await recordInboundSessionAndDispatchReply({
		...buildInboundReplyDispatchBase(params),
		deliver: params.deliver,
		onRecordError: params.onRecordError,
		onDispatchError: params.onDispatchError,
		replyOptions: params.replyOptions
	});
}
/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
async function recordInboundSessionAndDispatchReply(params) {
	await params.recordInboundSession({
		storePath: params.storePath,
		sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
		ctx: params.ctxPayload,
		onRecordError: params.onRecordError
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId
	});
	const deliver = createNormalizedOutboundDeliverer(params.deliver);
	await params.dispatchReplyWithBufferedBlockDispatcher({
		ctx: params.ctxPayload,
		cfg: params.cfg,
		dispatcherOptions: {
			...prefixOptions,
			deliver,
			onError: params.onDispatchError
		},
		replyOptions: {
			...params.replyOptions,
			onModelSelected
		}
	});
}
//#endregion
export { recordInboundSessionAndDispatchReply as i, dispatchInboundReplyWithBase as n, dispatchReplyFromConfigWithSettledDispatcher as r, buildInboundReplyDispatchBase as t };
