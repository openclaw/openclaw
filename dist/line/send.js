import { y as logVerbose } from "../utils-DZ2oAc5g.js";
import { t as loadConfig } from "../config-CpCccDYR.js";
import { t as recordChannelActivity } from "../channel-activity-DUOy6BRw.js";
import { resolveLineAccount } from "./accounts.js";
import { messagingApi } from "@line/bot-sdk";

//#region src/line/channel-access-token.ts
function resolveLineChannelAccessToken(explicit, params) {
	if (explicit?.trim()) return explicit.trim();
	if (!params.channelAccessToken) throw new Error(`LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`);
	return params.channelAccessToken.trim();
}

//#endregion
//#region src/line/send.ts
const userProfileCache = /* @__PURE__ */ new Map();
const PROFILE_CACHE_TTL_MS = 300 * 1e3;
function normalizeTarget(to) {
	const trimmed = to.trim();
	if (!trimmed) throw new Error("Recipient is required for LINE sends");
	let normalized = trimmed.replace(/^line:group:/i, "").replace(/^line:room:/i, "").replace(/^line:user:/i, "").replace(/^line:/i, "");
	if (!normalized) throw new Error("Recipient is required for LINE sends");
	return normalized;
}
function createLineMessagingClient(opts) {
	const account = resolveLineAccount({
		cfg: opts.cfg ?? loadConfig(),
		accountId: opts.accountId
	});
	const token = resolveLineChannelAccessToken(opts.channelAccessToken, account);
	return {
		account,
		client: new messagingApi.MessagingApiClient({ channelAccessToken: token })
	};
}
function createLinePushContext(to, opts) {
	const { account, client } = createLineMessagingClient(opts);
	return {
		account,
		client,
		chatId: normalizeTarget(to)
	};
}
function createTextMessage(text) {
	return {
		type: "text",
		text
	};
}
function createImageMessage(originalContentUrl, previewImageUrl) {
	return {
		type: "image",
		originalContentUrl,
		previewImageUrl: previewImageUrl ?? originalContentUrl
	};
}
function createLocationMessage(location) {
	return {
		type: "location",
		title: location.title.slice(0, 100),
		address: location.address.slice(0, 100),
		latitude: location.latitude,
		longitude: location.longitude
	};
}
function logLineHttpError(err, context) {
	if (!err || typeof err !== "object") return;
	const { status, statusText, body } = err;
	if (typeof body === "string") logVerbose(`line: ${context} failed (${status ? `${status} ${statusText ?? ""}`.trim() : "unknown status"}): ${body}`);
}
function recordLineOutboundActivity(accountId) {
	recordChannelActivity({
		channel: "line",
		accountId,
		direction: "outbound"
	});
}
async function pushLineMessages(to, messages, opts = {}, behavior = {}) {
	if (messages.length === 0) throw new Error("Message must be non-empty for LINE sends");
	const { account, client, chatId } = createLinePushContext(to, opts);
	const pushRequest = client.pushMessage({
		to: chatId,
		messages
	});
	if (behavior.errorContext) {
		const errorContext = behavior.errorContext;
		await pushRequest.catch((err) => {
			logLineHttpError(err, errorContext);
			throw err;
		});
	} else await pushRequest;
	recordLineOutboundActivity(account.accountId);
	if (opts.verbose) logVerbose(behavior.verboseMessage?.(chatId, messages.length) ?? `line: pushed ${messages.length} messages to ${chatId}`);
	return {
		messageId: "push",
		chatId
	};
}
async function replyLineMessages(replyToken, messages, opts = {}, behavior = {}) {
	const { account, client } = createLineMessagingClient(opts);
	await client.replyMessage({
		replyToken,
		messages
	});
	recordLineOutboundActivity(account.accountId);
	if (opts.verbose) logVerbose(behavior.verboseMessage?.(messages.length) ?? `line: replied with ${messages.length} messages`);
}
async function sendMessageLine(to, text, opts = {}) {
	const chatId = normalizeTarget(to);
	const messages = [];
	if (opts.mediaUrl?.trim()) messages.push(createImageMessage(opts.mediaUrl.trim()));
	if (text?.trim()) messages.push(createTextMessage(text.trim()));
	if (messages.length === 0) throw new Error("Message must be non-empty for LINE sends");
	if (opts.replyToken) {
		await replyLineMessages(opts.replyToken, messages, opts, { verboseMessage: () => `line: replied to ${chatId}` });
		return {
			messageId: "reply",
			chatId
		};
	}
	return pushLineMessages(chatId, messages, opts, { verboseMessage: (resolvedChatId) => `line: pushed message to ${resolvedChatId}` });
}
async function pushMessageLine(to, text, opts = {}) {
	return sendMessageLine(to, text, {
		...opts,
		replyToken: void 0
	});
}
async function replyMessageLine(replyToken, messages, opts = {}) {
	await replyLineMessages(replyToken, messages, opts);
}
async function pushMessagesLine(to, messages, opts = {}) {
	return pushLineMessages(to, messages, opts, { errorContext: "push message" });
}
function createFlexMessage(altText, contents) {
	return {
		type: "flex",
		altText,
		contents
	};
}
/**
* Push an image message to a user/group
*/
async function pushImageMessage(to, originalContentUrl, previewImageUrl, opts = {}) {
	return pushLineMessages(to, [createImageMessage(originalContentUrl, previewImageUrl)], opts, { verboseMessage: (chatId) => `line: pushed image to ${chatId}` });
}
/**
* Push a location message to a user/group
*/
async function pushLocationMessage(to, location, opts = {}) {
	return pushLineMessages(to, [createLocationMessage(location)], opts, { verboseMessage: (chatId) => `line: pushed location to ${chatId}` });
}
/**
* Push a Flex Message to a user/group
*/
async function pushFlexMessage(to, altText, contents, opts = {}) {
	return pushLineMessages(to, [{
		type: "flex",
		altText: altText.slice(0, 400),
		contents
	}], opts, {
		errorContext: "push flex message",
		verboseMessage: (chatId) => `line: pushed flex message to ${chatId}`
	});
}
/**
* Push a Template Message to a user/group
*/
async function pushTemplateMessage(to, template, opts = {}) {
	return pushLineMessages(to, [template], opts, { verboseMessage: (chatId) => `line: pushed template message to ${chatId}` });
}
/**
* Push a text message with quick reply buttons
*/
async function pushTextMessageWithQuickReplies(to, text, quickReplyLabels, opts = {}) {
	return pushLineMessages(to, [createTextMessageWithQuickReplies(text, quickReplyLabels)], opts, { verboseMessage: (chatId) => `line: pushed message with quick replies to ${chatId}` });
}
/**
* Create quick reply buttons to attach to a message
*/
function createQuickReplyItems(labels) {
	return { items: labels.slice(0, 13).map((label) => ({
		type: "action",
		action: {
			type: "message",
			label: label.slice(0, 20),
			text: label
		}
	})) };
}
/**
* Create a text message with quick reply buttons
*/
function createTextMessageWithQuickReplies(text, quickReplyLabels) {
	return {
		type: "text",
		text,
		quickReply: createQuickReplyItems(quickReplyLabels)
	};
}
/**
* Show loading animation to user (lasts up to 20 seconds or until next message)
*/
async function showLoadingAnimation(chatId, opts = {}) {
	const { client } = createLineMessagingClient(opts);
	try {
		await client.showLoadingAnimation({
			chatId: normalizeTarget(chatId),
			loadingSeconds: opts.loadingSeconds ?? 20
		});
		logVerbose(`line: showing loading animation to ${chatId}`);
	} catch (err) {
		logVerbose(`line: loading animation failed (non-fatal): ${String(err)}`);
	}
}
/**
* Fetch user profile (display name, picture URL)
*/
async function getUserProfile(userId, opts = {}) {
	if (opts.useCache ?? true) {
		const cached = userProfileCache.get(userId);
		if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) return {
			displayName: cached.displayName,
			pictureUrl: cached.pictureUrl
		};
	}
	const { client } = createLineMessagingClient(opts);
	try {
		const profile = await client.getProfile(userId);
		const result = {
			displayName: profile.displayName,
			pictureUrl: profile.pictureUrl
		};
		userProfileCache.set(userId, {
			...result,
			fetchedAt: Date.now()
		});
		return result;
	} catch (err) {
		logVerbose(`line: failed to fetch profile for ${userId}: ${String(err)}`);
		return null;
	}
}
/**
* Get user's display name (with fallback to userId)
*/
async function getUserDisplayName(userId, opts = {}) {
	return (await getUserProfile(userId, opts))?.displayName ?? userId;
}

//#endregion
export { createFlexMessage, createImageMessage, createLocationMessage, createQuickReplyItems, createTextMessageWithQuickReplies, getUserDisplayName, getUserProfile, pushFlexMessage, pushImageMessage, pushLocationMessage, pushMessageLine, pushMessagesLine, pushTemplateMessage, pushTextMessageWithQuickReplies, replyMessageLine, sendMessageLine, showLoadingAnimation };