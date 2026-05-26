import { _ as resolvePinnedHostnameWithPolicy } from "./ssrf-DdDeGa5L.js";
import { r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import "./fetch-runtime-BTAr6cKn.js";
import "./ssrf-runtime-Be2o3zD7.js";
//#region extensions/zalo/src/api.ts
/**
* Zalo Bot API client
* @see https://bot.zaloplatforms.com/docs
*/
const ZALO_API_BASE = "https://bot-api.zaloplatforms.com";
const ZALO_MEDIA_SSRF_POLICY = {};
var ZaloApiError = class extends Error {
	constructor(message, errorCode, description) {
		super(message);
		this.errorCode = errorCode;
		this.description = description;
		this.name = "ZaloApiError";
	}
	/** True if this is a long-polling timeout (no updates available) */
	get isPollingTimeout() {
		return this.errorCode === 408;
	}
};
/**
* Call the Zalo Bot API
*/
async function callZaloApi(method, token, body, options) {
	const url = `${ZALO_API_BASE}/bot${token}/${method}`;
	const controller = new AbortController();
	const timeoutId = options?.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : void 0;
	const fetcher = options?.fetch ?? fetch;
	try {
		const data = await (await fetcher(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : void 0,
			signal: controller.signal
		})).json();
		if (!data.ok) throw new ZaloApiError(data.description ?? `Zalo API error: ${method}`, data.error_code, data.description);
		return data;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
/**
* Validate bot token and get bot info
*/
async function getMe(token, timeoutMs, fetcher) {
	return callZaloApi("getMe", token, void 0, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Send a text message
*/
async function sendMessage(token, params, fetcher) {
	return callZaloApi("sendMessage", token, params, { fetch: fetcher });
}
/**
* Send a photo message
*/
async function sendPhoto(token, params, fetcher) {
	const photoUrl = params.photo.trim();
	let parsedPhotoUrl;
	try {
		parsedPhotoUrl = new URL(photoUrl);
	} catch {
		throw new Error("Zalo photo URL must be an absolute HTTP or HTTPS URL");
	}
	if (parsedPhotoUrl.protocol !== "http:" && parsedPhotoUrl.protocol !== "https:") throw new Error("Zalo photo URL must use HTTP or HTTPS");
	await resolvePinnedHostnameWithPolicy(parsedPhotoUrl.hostname, { policy: ZALO_MEDIA_SSRF_POLICY });
	return callZaloApi("sendPhoto", token, {
		...params,
		photo: parsedPhotoUrl.href
	}, { fetch: fetcher });
}
/**
* Send a temporary chat action such as typing.
*/
async function sendChatAction(token, params, fetcher, timeoutMs) {
	return callZaloApi("sendChatAction", token, params, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Get updates using long polling (dev/testing only)
* Note: Zalo returns a single update per call, not an array like Telegram
*/
async function getUpdates(token, params, fetcher) {
	const pollTimeoutSec = params?.timeout ?? 30;
	const timeoutMs = (pollTimeoutSec + 5) * 1e3;
	return callZaloApi("getUpdates", token, { timeout: String(pollTimeoutSec) }, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Set webhook URL for receiving updates
*/
async function setWebhook(token, params, fetcher) {
	return callZaloApi("setWebhook", token, params, { fetch: fetcher });
}
/**
* Delete webhook configuration
*/
async function deleteWebhook(token, fetcher, timeoutMs) {
	return callZaloApi("deleteWebhook", token, void 0, {
		timeoutMs,
		fetch: fetcher
	});
}
/**
* Get current webhook info
*/
async function getWebhookInfo(token, fetcher) {
	return callZaloApi("getWebhookInfo", token, void 0, { fetch: fetcher });
}
//#endregion
//#region extensions/zalo/src/proxy.ts
const proxyCache = /* @__PURE__ */ new Map();
function resolveZaloProxyFetch(proxyUrl) {
	const trimmed = proxyUrl?.trim();
	if (!trimmed) return;
	const cached = proxyCache.get(trimmed);
	if (cached) return cached;
	const fetcher = makeProxyFetch(trimmed);
	proxyCache.set(trimmed, fetcher);
	return fetcher;
}
//#endregion
export { getUpdates as a, sendMessage as c, getMe as i, sendPhoto as l, ZaloApiError as n, getWebhookInfo as o, deleteWebhook as r, sendChatAction as s, resolveZaloProxyFetch as t, setWebhook as u };
