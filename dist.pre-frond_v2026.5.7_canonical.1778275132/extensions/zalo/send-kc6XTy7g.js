import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import "../../error-runtime-BAONd32e.js";
import { a as resolveZaloToken, i as resolveZaloAccount } from "./accounts-BhLUp0WK.js";
import { c as sendMessage, l as sendPhoto, t as resolveZaloProxyFetch } from "./proxy-Bze1Jc-D.js";
//#region extensions/zalo/src/send.ts
function toZaloSendResult(response) {
	if (response.ok && response.result) return {
		ok: true,
		messageId: response.result.message_id
	};
	return {
		ok: false,
		error: "Failed to send message"
	};
}
async function runZaloSend(failureMessage, send) {
	try {
		const result = toZaloSendResult(await send());
		return result.ok ? result : {
			ok: false,
			error: failureMessage
		};
	} catch (err) {
		return {
			ok: false,
			error: formatErrorMessage(err)
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
		error: context.error
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
	return await runZaloSend("Failed to send message", () => sendMessage(context.token, {
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
		error: "No photo URL provided"
	};
	return await runZaloSend("Failed to send photo", () => (async () => sendPhoto(context.token, {
		chat_id: context.chatId,
		photo: photoUrl.trim(),
		caption: options.caption?.slice(0, 2e3)
	}, context.fetcher))());
}
//#endregion
export { sendMessageZalo as t };
