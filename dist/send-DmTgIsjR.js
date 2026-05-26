import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import "./error-runtime-DGHc7DZw.js";
import "./channel-message-DMGbyII_.js";
import { a as resolveZaloToken, i as resolveZaloAccount } from "./accounts-CZtuHf49.js";
import { c as sendMessage, l as sendPhoto, t as resolveZaloProxyFetch } from "./proxy-BWFfui0N.js";
//#region extensions/zalo/src/send.ts
function createZaloSendReceipt(params) {
	const messageId = params.messageId?.trim();
	return createMessageReceiptFromOutboundResults({
		results: messageId ? [{
			channel: "zalo",
			messageId,
			chatId: params.chatId
		}] : [],
		kind: params.kind
	});
}
function toZaloSendResult(response, params) {
	if (response.ok && response.result) return {
		ok: true,
		messageId: response.result.message_id,
		receipt: createZaloSendReceipt({
			messageId: response.result.message_id,
			chatId: params.chatId,
			kind: params.kind
		})
	};
	return {
		ok: false,
		error: "Failed to send message",
		receipt: createZaloSendReceipt({
			chatId: params.chatId,
			kind: params.kind
		})
	};
}
async function runZaloSend(failureMessage, params, send) {
	try {
		const result = toZaloSendResult(await send(), params);
		return result.ok ? result : {
			ok: false,
			error: failureMessage,
			receipt: result.receipt
		};
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err),
			receipt: createZaloSendReceipt({
				chatId: params.chatId,
				kind: params.kind
			})
		};
	}
}
function resolveSendContext(options) {
	if (options.cfg) {
		const account = resolveZaloAccount({
			cfg: options.cfg,
			accountId: options.accountId
		});
		return {
			token: options.token || account.token,
			fetcher: resolveZaloProxyFetch(options.proxy ?? account.config.proxy)
		};
	}
	const token = options.token ?? resolveZaloToken(void 0, options.accountId).token;
	const proxy = options.proxy;
	return {
		token,
		fetcher: resolveZaloProxyFetch(proxy)
	};
}
function resolveValidatedSendContext(chatId, options) {
	const { token, fetcher } = resolveSendContext(options);
	if (!token) return {
		ok: false,
		error: "No Zalo bot token configured"
	};
	const trimmedChatId = chatId?.trim();
	if (!trimmedChatId) return {
		ok: false,
		error: "No chat_id provided"
	};
	return {
		ok: true,
		chatId: trimmedChatId,
		token,
		fetcher
	};
}
function resolveSendContextOrFailure(chatId, options) {
	const context = resolveValidatedSendContext(chatId, options);
	return context.ok ? { context } : { failure: {
		ok: false,
		error: context.error,
		receipt: createZaloSendReceipt({
			chatId,
			kind: "unknown"
		})
	} };
}
async function sendMessageZalo(chatId, text, options = {}) {
	const resolved = resolveSendContextOrFailure(chatId, options);
	if ("failure" in resolved) return resolved.failure;
	const { context } = resolved;
	if (options.mediaUrl) return sendPhotoZalo(context.chatId, options.mediaUrl, {
		...options,
		token: context.token,
		caption: text || options.caption
	});
	return await runZaloSend("Failed to send message", {
		chatId: context.chatId,
		kind: "text"
	}, () => sendMessage(context.token, {
		chat_id: context.chatId,
		text: text.slice(0, 2e3)
	}, context.fetcher));
}
async function sendPhotoZalo(chatId, photoUrl, options = {}) {
	const resolved = resolveSendContextOrFailure(chatId, options);
	if ("failure" in resolved) return resolved.failure;
	const { context } = resolved;
	if (!photoUrl?.trim()) return {
		ok: false,
		error: "No photo URL provided",
		receipt: createZaloSendReceipt({
			chatId: context.chatId,
			kind: "media"
		})
	};
	return await runZaloSend("Failed to send photo", {
		chatId: context.chatId,
		kind: "media"
	}, () => (async () => sendPhoto(context.token, {
		chat_id: context.chatId,
		photo: photoUrl.trim(),
		caption: options.caption?.slice(0, 2e3)
	}, context.fetcher))());
}
//#endregion
export { sendMessageZalo as t };
