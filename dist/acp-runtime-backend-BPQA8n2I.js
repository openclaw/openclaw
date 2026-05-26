import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./errors-BgH2aVJW.js";
import "./registry-KuKuvijT.js";
//#region src/plugin-sdk/acp-runtime-backend.ts
let dispatchAcpRuntimePromise = null;
function loadDispatchAcpRuntime() {
	dispatchAcpRuntimePromise ??= import("./dispatch-acp.runtime.js");
	return dispatchAcpRuntimePromise;
}
function hasExplicitCommandCandidate(ctx) {
	if (normalizeOptionalString(ctx.CommandBody)) return true;
	const normalized = normalizeOptionalString(ctx.BodyForCommands);
	if (!normalized) return false;
	return normalized.startsWith("!") || normalized.startsWith("/");
}
async function tryDispatchAcpReplyHook(event, ctx) {
	if (event.sendPolicy === "deny" && !event.suppressUserDelivery && !hasExplicitCommandCandidate(event.ctx) && !event.isTailDispatch) return;
	const runtime = await loadDispatchAcpRuntime();
	const bypassForCommand = await runtime.shouldBypassAcpDispatchForCommand(event.ctx, ctx.cfg);
	if (event.sendPolicy === "deny" && !event.suppressUserDelivery && !bypassForCommand && !event.isTailDispatch) return;
	const result = await runtime.tryDispatchAcpReply({
		ctx: event.ctx,
		cfg: ctx.cfg,
		dispatcher: ctx.dispatcher,
		runId: event.runId,
		sessionKey: event.sessionKey,
		images: event.images,
		abortSignal: ctx.abortSignal,
		inboundAudio: event.inboundAudio,
		sessionTtsAuto: event.sessionTtsAuto,
		ttsChannel: event.ttsChannel,
		suppressUserDelivery: event.suppressUserDelivery,
		suppressReplyLifecycle: event.suppressReplyLifecycle === true || event.sendPolicy === "deny",
		sourceReplyDeliveryMode: event.sourceReplyDeliveryMode,
		shouldRouteToOriginating: event.shouldRouteToOriginating,
		originatingChannel: event.originatingChannel,
		originatingTo: event.originatingTo,
		shouldSendToolSummaries: event.shouldSendToolSummaries,
		bypassForCommand,
		onReplyStart: ctx.onReplyStart,
		recordProcessed: ctx.recordProcessed,
		markIdle: ctx.markIdle
	});
	if (!result) return;
	return {
		handled: true,
		queuedFinal: result.queuedFinal,
		counts: result.counts
	};
}
//#endregion
export { tryDispatchAcpReplyHook as t };
