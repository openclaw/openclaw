import { f as renderMessagePresentationFallbackText, l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam, h as readStringOrNumberParam, m as readStringArrayParam, p as readReactionParams } from "./common-E9YpX7pB.js";
import { r as resolvePollMaxSelections } from "./polls-C-v11_tu.js";
import { t as readBooleanParam } from "./boolean-param-Ch5dc2FQ.js";
import { t as resolveTelegramToken } from "./token-CEwSHtbY.js";
import { r as resolveReactionMessageId } from "./channel-actions-DMN7G5RZ.js";
import { c as resolveTelegramPollActionGateState, t as createTelegramActionGate } from "./accounts-CYn64t2S.js";
import { a as resolveTelegramTargetChatType, i as parseTelegramTarget } from "./targets-D0gFWyUZ.js";
import { r as resolveTelegramInlineButtonsScope } from "./inline-buttons-BoL8hmdC.js";
import { t as resolveTelegramInlineButtons } from "./button-types-C0Gyj4Tz.js";
import { t as resolveTelegramInteractiveTextFallback } from "./interactive-fallback-hkNKT0cd.js";
import { t as resolveTelegramReactionLevel } from "./reaction-level-DqO7AeAj.js";
import { i as getCacheStats, o as searchStickers } from "./sticker-cache-qT7KSXbD.js";
import { a as editMessageTelegram, d as sendPollTelegram, f as sendStickerTelegram, n as deleteMessageTelegram, o as pinMessageTelegram, r as editForumTopicTelegram, s as reactMessageTelegram, t as createForumTopicTelegram, u as sendMessageTelegram } from "./send-HzJbRmiM.js";
import { t as resolveTelegramPollVisibility } from "./poll-visibility-Ds4ydsWS.js";
import { n as notifyTelegramInboundEventOutboundSuccess } from "./inbound-event-delivery-CU-tJK1Q.js";
//#region extensions/telegram/src/action-runtime.ts
const telegramActionRuntime = {
	createForumTopicTelegram,
	deleteMessageTelegram,
	editForumTopicTelegram,
	editMessageTelegram,
	getCacheStats,
	pinMessageTelegram,
	reactMessageTelegram,
	searchStickers,
	sendMessageTelegram,
	sendPollTelegram,
	sendStickerTelegram
};
const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
	7322096,
	16766590,
	13338331,
	9367192,
	16749490,
	16478047
];
const TELEGRAM_ACTION_ALIASES = {
	createForumTopic: "createForumTopic",
	delete: "deleteMessage",
	deleteMessage: "deleteMessage",
	edit: "editMessage",
	editForumTopic: "editForumTopic",
	editMessage: "editMessage",
	poll: "poll",
	react: "react",
	searchSticker: "searchSticker",
	send: "sendMessage",
	sendMessage: "sendMessage",
	sendSticker: "sendSticker",
	sticker: "sendSticker",
	stickerCacheStats: "stickerCacheStats",
	"sticker-search": "searchSticker",
	"topic-create": "createForumTopic",
	"topic-edit": "editForumTopic"
};
function readTelegramForumTopicIconColor(params) {
	const iconColor = readNumberParam(params, "iconColor", { integer: true });
	if (iconColor == null) return;
	if (!TELEGRAM_FORUM_TOPIC_ICON_COLORS.includes(iconColor)) throw new Error("iconColor must be one of Telegram's supported forum topic colors.");
	return iconColor;
}
function normalizeTelegramActionName(action) {
	const normalized = TELEGRAM_ACTION_ALIASES[action];
	if (!normalized) throw new Error(`Unsupported Telegram action: ${action}`);
	return normalized;
}
function readTelegramChatId(params) {
	return readStringOrNumberParam(params, "chatId") ?? readStringOrNumberParam(params, "channelId") ?? readStringOrNumberParam(params, "to", { required: true });
}
function readTelegramThreadId(params) {
	return readNumberParam(params, "messageThreadId", { integer: true }) ?? readNumberParam(params, "threadId", { integer: true });
}
function formatTelegramDeliveryTarget(to, messageThreadId) {
	const parsed = parseTelegramTarget(to);
	const topicId = parsed.messageThreadId ?? messageThreadId;
	if (topicId == null) return to;
	return `${parsed.chatId}:topic:${topicId}`;
}
function readTelegramReplyToMessageId(params) {
	return readNumberParam(params, "replyToMessageId", { integer: true }) ?? readNumberParam(params, "replyTo", { integer: true });
}
function resolveTelegramButtonsFromParams(params, presentation = normalizeMessagePresentation(params.presentation)) {
	return resolveTelegramInlineButtons({
		presentation,
		interactive: params.interactive
	});
}
function readTelegramSendContent(params) {
	const explicitContent = readStringParam(params.args, "content", { allowEmpty: true }) ?? readStringParam(params.args, "message", { allowEmpty: true }) ?? readStringParam(params.args, "caption", { allowEmpty: true });
	const presentationText = explicitContent == null && params.presentation ? renderMessagePresentationFallbackText({ presentation: params.presentation }) : void 0;
	const interactiveText = explicitContent == null && !params.presentation ? resolveTelegramInteractiveTextFallback({ interactive: params.interactive }) : void 0;
	let content = explicitContent ?? (presentationText?.trim() ? presentationText : void 0) ?? (interactiveText?.trim() ? interactiveText : void 0);
	if ((content == null || content.trim().length === 0) && !params.mediaUrl && params.hasButtons) {
		const fallback = presentationText?.trim() ? presentationText : interactiveText;
		if (fallback?.trim()) content = fallback;
	}
	if (content == null && !params.mediaUrl && !params.hasButtons) throw new Error("content required.");
	return content ?? "";
}
function normalizeTelegramDeliveryPin(params) {
	const delivery = params.delivery;
	const pin = delivery && typeof delivery === "object" && !Array.isArray(delivery) ? delivery.pin : params.pin === true ? true : void 0;
	if (pin === true) return { enabled: true };
	if (!pin || typeof pin !== "object" || Array.isArray(pin)) return;
	const raw = pin;
	if (raw.enabled !== true) return;
	return {
		enabled: true,
		...raw.notify === true ? { notify: true } : {},
		...raw.required === true ? { required: true } : {}
	};
}
async function maybePinTelegramActionSend(params) {
	const pin = normalizeTelegramDeliveryPin(params.args);
	if (!pin) return;
	if (!params.messageId) {
		if (pin.required) throw new Error("Telegram delivery pin requested, but no message id was returned.");
		return;
	}
	try {
		await telegramActionRuntime.pinMessageTelegram(params.to, params.messageId, {
			cfg: params.cfg,
			accountId: params.accountId,
			notify: pin.notify,
			verbose: false,
			gatewayClientScopes: params.gatewayClientScopes
		});
	} catch (err) {
		if (pin.required) throw err;
	}
}
async function handleTelegramAction(params, cfg, options) {
	const { action, accountId } = {
		action: normalizeTelegramActionName(readStringParam(params, "action", { required: true })),
		accountId: readStringParam(params, "accountId")
	};
	const isActionEnabled = createTelegramActionGate({
		cfg,
		accountId
	});
	const notifyVisibleOutboundSuccess = (to, messageThreadId) => {
		notifyTelegramInboundEventOutboundSuccess({
			sessionKey: options?.sessionKey ?? void 0,
			to: formatTelegramDeliveryTarget(to, messageThreadId),
			accountId,
			inboundEventKind: options?.inboundEventKind
		});
	};
	if (action === "react") {
		const reactionLevelInfo = resolveTelegramReactionLevel({
			cfg,
			accountId: accountId ?? void 0
		});
		if (!reactionLevelInfo.agentReactionsEnabled) return jsonResult({
			ok: false,
			reason: "disabled",
			hint: `Telegram agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Do not retry.`
		});
		if (!isActionEnabled("reactions")) return jsonResult({
			ok: false,
			reason: "disabled",
			hint: "Telegram reactions are disabled via actions.reactions. Do not retry."
		});
		const chatId = readTelegramChatId(params);
		const messageId = readNumberParam(params, "messageId", { integer: true }) ?? resolveReactionMessageId({ args: params });
		if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) return jsonResult({
			ok: false,
			reason: "missing_message_id",
			hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry."
		});
		const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Telegram reaction." });
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) return jsonResult({
			ok: false,
			reason: "missing_token",
			hint: "Telegram bot token missing. Do not retry."
		});
		let reactionResult;
		try {
			reactionResult = await telegramActionRuntime.reactMessageTelegram(chatId ?? "", messageId ?? 0, emoji ?? "", {
				cfg,
				token,
				remove,
				accountId: accountId ?? void 0,
				gatewayClientScopes: options?.gatewayClientScopes
			});
		} catch (err) {
			const isInvalid = String(err).includes("REACTION_INVALID");
			return jsonResult({
				ok: false,
				reason: isInvalid ? "REACTION_INVALID" : "error",
				emoji,
				hint: isInvalid ? "This emoji is not supported for Telegram reactions. Add it to your reaction disallow list so you do not try it again." : "Reaction failed. Do not retry."
			});
		}
		if (!reactionResult.ok) return jsonResult({
			ok: false,
			warning: reactionResult.warning,
			...remove || isEmpty ? { removed: true } : { added: emoji }
		});
		if (!remove && !isEmpty) return jsonResult({
			ok: true,
			added: emoji
		});
		return jsonResult({
			ok: true,
			removed: true
		});
	}
	if (action === "sendMessage") {
		if (!isActionEnabled("sendMessage")) throw new Error("Telegram sendMessage is disabled.");
		const to = readStringParam(params, "to", { required: true });
		const mediaUrl = readStringParam(params, "mediaUrl") ?? readStringParam(params, "media", { trim: false });
		const presentation = normalizeMessagePresentation(params.presentation);
		const buttons = resolveTelegramButtonsFromParams(params, presentation);
		const content = readTelegramSendContent({
			args: params,
			mediaUrl: mediaUrl ?? void 0,
			hasButtons: Array.isArray(buttons) && buttons.length > 0,
			interactive: params.interactive,
			presentation
		});
		if (buttons) {
			const inlineButtonsScope = resolveTelegramInlineButtonsScope({
				cfg,
				accountId: accountId ?? void 0
			});
			if (inlineButtonsScope === "off") throw new Error("Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to \"dm\", \"group\", \"all\", or \"allowlist\".");
			if (inlineButtonsScope === "dm" || inlineButtonsScope === "group") {
				const targetType = resolveTelegramTargetChatType(to);
				if (targetType === "unknown") throw new Error(`Telegram inline buttons require a numeric chat id when inlineButtons="${inlineButtonsScope}".`);
				if (inlineButtonsScope === "dm" && targetType !== "direct") throw new Error("Telegram inline buttons are limited to DMs when inlineButtons=\"dm\".");
				if (inlineButtonsScope === "group" && targetType !== "group") throw new Error("Telegram inline buttons are limited to groups when inlineButtons=\"group\".");
			}
		}
		const replyToMessageId = readTelegramReplyToMessageId(params);
		const messageThreadId = readTelegramThreadId(params);
		const quoteText = readStringParam(params, "quoteText");
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.sendMessageTelegram(to, content, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			mediaUrl: mediaUrl || void 0,
			mediaLocalRoots: options?.mediaLocalRoots,
			mediaReadFile: options?.mediaReadFile,
			gatewayClientScopes: options?.gatewayClientScopes,
			buttons,
			replyToMessageId: replyToMessageId ?? void 0,
			messageThreadId: messageThreadId ?? void 0,
			quoteText: quoteText ?? void 0,
			asVoice: readBooleanParam(params, "asVoice"),
			silent: readBooleanParam(params, "silent"),
			forceDocument: readBooleanParam(params, "forceDocument") ?? readBooleanParam(params, "asDocument") ?? false
		});
		notifyVisibleOutboundSuccess(to, messageThreadId);
		await maybePinTelegramActionSend({
			args: params,
			cfg,
			accountId: accountId ?? void 0,
			to,
			messageId: result.messageId,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		return jsonResult({
			ok: true,
			messageId: result.messageId,
			chatId: result.chatId
		});
	}
	if (action === "poll") {
		const pollActionState = resolveTelegramPollActionGateState(isActionEnabled);
		if (!pollActionState.sendMessageEnabled) throw new Error("Telegram sendMessage is disabled.");
		if (!pollActionState.pollEnabled) throw new Error("Telegram polls are disabled.");
		const to = readStringParam(params, "to", { required: true });
		const question = readStringParam(params, "question") ?? readStringParam(params, "pollQuestion", { required: true });
		const answers = readStringArrayParam(params, "answers") ?? readStringArrayParam(params, "pollOption", { required: true });
		const allowMultiselect = readBooleanParam(params, "allowMultiselect") ?? readBooleanParam(params, "pollMulti");
		const durationSeconds = readNumberParam(params, "durationSeconds", { integer: true }) ?? readNumberParam(params, "pollDurationSeconds", {
			integer: true,
			strict: true
		});
		const durationHours = readNumberParam(params, "durationHours", { integer: true }) ?? readNumberParam(params, "pollDurationHours", {
			integer: true,
			strict: true
		});
		const replyToMessageId = readTelegramReplyToMessageId(params);
		const messageThreadId = readTelegramThreadId(params);
		const isAnonymous = readBooleanParam(params, "isAnonymous") ?? resolveTelegramPollVisibility({
			pollAnonymous: readBooleanParam(params, "pollAnonymous"),
			pollPublic: readBooleanParam(params, "pollPublic")
		});
		const silent = readBooleanParam(params, "silent");
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.sendPollTelegram(to, {
			question,
			options: answers,
			maxSelections: resolvePollMaxSelections(answers.length, allowMultiselect ?? false),
			durationSeconds: durationSeconds ?? void 0,
			durationHours: durationHours ?? void 0
		}, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			replyToMessageId: replyToMessageId ?? void 0,
			messageThreadId: messageThreadId ?? void 0,
			isAnonymous: isAnonymous ?? void 0,
			silent: silent ?? void 0,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		notifyVisibleOutboundSuccess(to, messageThreadId);
		return jsonResult({
			ok: true,
			messageId: result.messageId,
			chatId: result.chatId,
			pollId: result.pollId
		});
	}
	if (action === "deleteMessage") {
		if (!isActionEnabled("deleteMessage")) throw new Error("Telegram deleteMessage is disabled.");
		const chatId = readTelegramChatId(params);
		const messageId = readNumberParam(params, "messageId", {
			required: true,
			integer: true
		});
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.deleteMessageTelegram(chatId ?? "", messageId ?? 0, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		if (!result.ok) return jsonResult({
			ok: false,
			deleted: false,
			warning: result.warning
		});
		return jsonResult({
			ok: true,
			deleted: true
		});
	}
	if (action === "editMessage") {
		if (!isActionEnabled("editMessage")) throw new Error("Telegram editMessage is disabled.");
		const chatId = readTelegramChatId(params);
		const messageId = readNumberParam(params, "messageId", {
			required: true,
			integer: true
		});
		const content = readStringParam(params, "content", { allowEmpty: false }) ?? readStringParam(params, "message", {
			required: true,
			allowEmpty: false
		});
		const buttons = resolveTelegramButtonsFromParams(params);
		if (buttons) {
			if (resolveTelegramInlineButtonsScope({
				cfg,
				accountId: accountId ?? void 0
			}) === "off") throw new Error("Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to \"dm\", \"group\", \"all\", or \"allowlist\".");
		}
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.editMessageTelegram(chatId ?? "", messageId ?? 0, content, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			buttons,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		return jsonResult({
			ok: true,
			messageId: result.messageId,
			chatId: result.chatId
		});
	}
	if (action === "sendSticker") {
		if (!isActionEnabled("sticker", false)) throw new Error("Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.");
		const to = readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
		const fileId = readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
		if (!fileId) throw new Error("fileId is required.");
		const replyToMessageId = readTelegramReplyToMessageId(params);
		const messageThreadId = readTelegramThreadId(params);
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.sendStickerTelegram(to, fileId, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			replyToMessageId: replyToMessageId ?? void 0,
			messageThreadId: messageThreadId ?? void 0,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		notifyVisibleOutboundSuccess(to, messageThreadId);
		return jsonResult({
			ok: true,
			messageId: result.messageId,
			chatId: result.chatId
		});
	}
	if (action === "searchSticker") {
		if (!isActionEnabled("sticker", false)) throw new Error("Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.");
		const query = readStringParam(params, "query", { required: true });
		const limit = readNumberParam(params, "limit", { integer: true }) ?? 5;
		const results = telegramActionRuntime.searchStickers(query, limit);
		return jsonResult({
			ok: true,
			count: results.length,
			stickers: results.map((s) => ({
				fileId: s.fileId,
				emoji: s.emoji,
				description: s.description,
				setName: s.setName
			}))
		});
	}
	if (action === "stickerCacheStats") return jsonResult({
		ok: true,
		...telegramActionRuntime.getCacheStats()
	});
	if (action === "createForumTopic") {
		if (!isActionEnabled("createForumTopic")) throw new Error("Telegram createForumTopic is disabled.");
		const chatId = readTelegramChatId(params);
		const name = readStringParam(params, "name", { required: true });
		const iconColor = readTelegramForumTopicIconColor(params);
		const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		const result = await telegramActionRuntime.createForumTopicTelegram(chatId ?? "", name, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			iconColor,
			iconCustomEmojiId: iconCustomEmojiId ?? void 0,
			gatewayClientScopes: options?.gatewayClientScopes
		});
		return jsonResult({
			ok: true,
			topicId: result.topicId,
			name: result.name,
			chatId: result.chatId
		});
	}
	if (action === "editForumTopic") {
		if (!isActionEnabled("editForumTopic")) throw new Error("Telegram editForumTopic is disabled.");
		const chatId = readTelegramChatId(params);
		const messageThreadId = readTelegramThreadId(params);
		if (typeof messageThreadId !== "number") throw new Error("messageThreadId or threadId is required.");
		const name = readStringParam(params, "name");
		const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
		const token = resolveTelegramToken(cfg, { accountId }).token;
		if (!token) throw new Error("Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.");
		return jsonResult(await telegramActionRuntime.editForumTopicTelegram(chatId ?? "", messageThreadId, {
			cfg,
			token,
			accountId: accountId ?? void 0,
			name: name ?? void 0,
			iconCustomEmojiId: iconCustomEmojiId ?? void 0,
			gatewayClientScopes: options?.gatewayClientScopes
		}));
	}
	throw new Error(`Unsupported Telegram action: ${String(action)}`);
}
//#endregion
export { handleTelegramAction, telegramActionRuntime };
