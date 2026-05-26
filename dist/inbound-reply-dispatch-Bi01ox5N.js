import { i as dispatchReplyFromConfig, o as withReplyDispatcher } from "./dispatch-cQjCJvZr.js";
import { d as normalizeOutboundReplyPayload } from "./reply-payload-DMPQsrQC.js";
import { a as runPreparedChannelTurn, d as throwIfDurableInboundReplyDeliveryFailed, i as runChannelTurn, l as deliverInboundReplyWithMessageSendContext, u as isDurableInboundReplyDeliveryHandled } from "./kernel-BXIm_f4L.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { i as resolveChannelTurnDispatchCounts, n as hasFinalChannelTurnDispatch, r as hasVisibleChannelTurnDispatch } from "./dispatch-result-BM3RYtx4.js";
import "./channel-reply-core-DGuOv4fh.js";
//#region src/plugin-sdk/inbound-reply-dispatch.ts
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
/**
* Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
*
* @deprecated Compatibility reply-dispatch bridge. New channel plugins should
* expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
* sends through `deliverInboundReplyWithMessageSendContext(...)` or
* `sendDurableMessageBatch(...)`.
*/
async function dispatchChannelMessageReplyWithBase(params) {
	await recordChannelMessageReplyDispatch({
		...buildInboundReplyDispatchBase(params),
		deliver: params.deliver,
		durable: params.durable,
		onRecordError: params.onRecordError,
		onDispatchError: params.onDispatchError,
		replyOptions: params.replyOptions
	});
}
/**
* Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
*
* @deprecated Legacy inbound reply helper. New channel plugins should expose a
* `message` adapter via `defineChannelMessageAdapter(...)` and use
* `dispatchChannelMessageReplyWithBase` only for compatibility dispatchers that
* have not moved to the message lifecycle yet.
*/
async function dispatchInboundReplyWithBase(params) {
	await dispatchChannelMessageReplyWithBase(params);
}
/**
* Record the inbound session first, then dispatch the reply using normalized outbound delivery.
*
* @deprecated Compatibility reply-dispatch bridge. New channel plugins should
* expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
* sends through `deliverInboundReplyWithMessageSendContext(...)` or
* `sendDurableMessageBatch(...)`.
*/
async function recordChannelMessageReplyDispatch(params) {
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: params.channel,
		accountId: params.accountId
	});
	const deliver = async (payload, info) => {
		const normalized = payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {};
		if (params.durable) {
			const durable = await deliverInboundReplyWithMessageSendContext({
				cfg: params.cfg,
				channel: params.channel,
				accountId: params.accountId,
				agentId: params.agentId,
				ctxPayload: params.ctxPayload,
				payload: normalized,
				info,
				...params.durable
			});
			throwIfDurableInboundReplyDeliveryFailed(durable);
			if (isDurableInboundReplyDeliveryHandled(durable)) return;
		}
		await params.deliver(normalized);
	};
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
/**
* Record the inbound session first, then dispatch the reply using normalized outbound delivery.
*
* @deprecated Legacy inbound reply helper. New channel plugins should expose a
* `message` adapter via `defineChannelMessageAdapter(...)` and use
* `recordChannelMessageReplyDispatch` only for compatibility dispatchers that
* have not moved to the message lifecycle yet.
*/
async function recordInboundSessionAndDispatchReply(params) {
	await recordChannelMessageReplyDispatch(params);
}
/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
const buildChannelMessageReplyDispatchBase = buildInboundReplyDispatchBase;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
const hasFinalChannelMessageReplyDispatch = hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
const hasVisibleChannelMessageReplyDispatch = hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
const resolveChannelMessageReplyDispatchCounts = resolveChannelTurnDispatchCounts;
//#endregion
export { dispatchReplyFromConfigWithSettledDispatcher as a, recordChannelMessageReplyDispatch as c, runInboundReplyTurn as d, runPreparedInboundReplyTurn as f, dispatchInboundReplyWithBase as i, recordInboundSessionAndDispatchReply as l, buildInboundReplyDispatchBase as n, hasFinalChannelMessageReplyDispatch as o, dispatchChannelMessageReplyWithBase as r, hasVisibleChannelMessageReplyDispatch as s, buildChannelMessageReplyDispatchBase as t, resolveChannelMessageReplyDispatchCounts as u };
