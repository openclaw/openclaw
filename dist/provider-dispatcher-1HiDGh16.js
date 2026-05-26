import { n as dispatchInboundMessageWithBufferedDispatcher, r as dispatchInboundMessageWithDispatcher } from "./dispatch-cQjCJvZr.js";
//#region src/auto-reply/reply/provider-dispatcher.ts
const dispatchReplyWithBufferedBlockDispatcher = async (params) => {
	return await dispatchInboundMessageWithBufferedDispatcher({
		ctx: params.ctx,
		cfg: params.cfg,
		dispatcherOptions: params.dispatcherOptions,
		replyResolver: params.replyResolver,
		replyOptions: params.replyOptions
	});
};
const dispatchReplyWithDispatcher = async (params) => {
	return await dispatchInboundMessageWithDispatcher({
		ctx: params.ctx,
		cfg: params.cfg,
		dispatcherOptions: params.dispatcherOptions,
		replyResolver: params.replyResolver,
		replyOptions: params.replyOptions
	});
};
//#endregion
export { dispatchReplyWithDispatcher as n, dispatchReplyWithBufferedBlockDispatcher as t };
