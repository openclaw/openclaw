import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { t as loadChannelOutboundAdapter } from "./load-CvxrRePI.js";
//#region src/cli/send-runtime/channel-outbound-send.ts
function resolveRuntimeThreadId(opts) {
	return opts.messageThreadId ?? opts.threadId ?? opts.threadTs ?? void 0;
}
function resolveRuntimeReplyToId(opts) {
	const raw = opts.replyToMessageId ?? opts.replyToId;
	return raw == null ? void 0 : normalizeOptionalString(String(raw));
}
function createChannelOutboundRuntimeSend(params) {
	return { sendMessage: async (to, text, opts = {}) => {
		const outbound = await loadChannelOutboundAdapter(params.channelId);
		const threadId = resolveRuntimeThreadId(opts);
		const replyToId = resolveRuntimeReplyToId(opts);
		const buildContext = () => ({
			cfg: opts.cfg ?? getRuntimeConfig(),
			to,
			text,
			mediaUrl: opts.mediaUrl,
			mediaAccess: opts.mediaAccess,
			mediaLocalRoots: opts.mediaLocalRoots,
			mediaReadFile: opts.mediaReadFile,
			accountId: opts.accountId,
			threadId,
			replyToId,
			silent: opts.silent,
			forceDocument: opts.forceDocument,
			formatting: opts.formatting ?? (opts.textMode === "html" ? { parseMode: "HTML" } : void 0),
			gifPlayback: opts.gifPlayback,
			gatewayClientScopes: opts.gatewayClientScopes
		});
		const hasMedia = Boolean(opts.mediaUrl);
		if (opts.blocks && outbound?.sendPayload) return await outbound.sendPayload({
			...buildContext(),
			payload: {
				text,
				channelData: { [params.channelId]: { blocks: opts.blocks } }
			}
		});
		if (hasMedia && outbound?.sendMedia) return await outbound.sendMedia(buildContext());
		if (!outbound?.sendText) throw new Error(params.unavailableMessage);
		return await outbound.sendText(buildContext());
	} };
}
//#endregion
export { createChannelOutboundRuntimeSend };
