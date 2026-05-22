import { n as createNormalizedOutboundDeliverer } from "./reply-payload-4x-lSxGs.js";
import { c as withReplyDispatcher, o as dispatchReplyFromConfig } from "./dispatch-CmWEZqy1.js";
import { n as runChannelTurn, r as runPreparedChannelTurn } from "./kernel-DFfH00p_.js";
import { t as createChannelReplyPipeline } from "./channel-reply-pipeline-ChCtYK0Y.js";
//#region src/plugin-sdk/inbound-reply-dispatch.ts
/** Run an already assembled channel turn through shared session-record + dispatch ordering. */
async function runPreparedInboundReplyTurn(params) {
	return await runPreparedChannelTurn(params);
}
/** Run a channel turn through shared ingest, record, dispatch, and finalize ordering. */
async function runInboundReplyTurn(params) {
	return await runChannelTurn(params);
}
/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
async function dispatchReplyFromConfigWithSettledDispatcher(params) {
	return await withReplyDispatcher({
		dispatcher: params.dispatcher,
		onSettled: params.onSettled,
		run: () => dispatchReplyFromConfig({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcher: params.dispatcher,
			replyOptions: params.replyOptions,
			configOverride: params.configOverride
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
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId
	});
	const deliver = createNormalizedOutboundDeliverer(params.deliver);
	await runPreparedChannelTurn({
		channel: params.channel,
		accountId: params.accountId,
		routeSessionKey: params.routeSessionKey,
		storePath: params.storePath,
		ctxPayload: params.ctxPayload,
		recordInboundSession: params.recordInboundSession,
		record: { onRecordError: params.onRecordError },
		runDispatch: async () => await params.dispatchReplyWithBufferedBlockDispatcher({
			ctx: params.ctxPayload,
			cfg: params.cfg,
			dispatcherOptions: {
				...replyPipeline,
				deliver,
				onError: params.onDispatchError
			},
			replyOptions: {
				...params.replyOptions,
				onModelSelected
			}
		})
	});
}
//#endregion
export { runInboundReplyTurn as a, recordInboundSessionAndDispatchReply as i, dispatchInboundReplyWithBase as n, runPreparedInboundReplyTurn as o, dispatchReplyFromConfigWithSettledDispatcher as r, buildInboundReplyDispatchBase as t };
