import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as parseAccessGroupAllowFromEntry, i as mergeDmAllowFromSources, n as firstDefined, r as isSenderIdAllowed } from "./allow-from-D1f7S_rf.js";
import { a as readChannelAllowFromStore } from "./pairing-store-jPMfFWFn.js";
import { t as resolveCommandAuthorization } from "./command-auth-B6j-kluy.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { i as markdownToIR, n as renderMarkdownWithMarkers } from "./tables-D3y68tNR.js";
import "./conversation-runtime-guwDSNIo.js";
import { r as renderMarkdownIRChunksWithinLimit } from "./chunk-items-4pJLz72Q.js";
import { n as isAutoLinkedFileRef, t as FILE_REF_EXTENSIONS_WITH_TLD } from "./auto-linked-file-ref-kqLj-Euu.js";
import "./text-chunking-C154U6-i.js";
import "./security-runtime-CcSekjBd.js";
import { t as expandAllowFromWithAccessGroups } from "./access-groups-Blp1EmmC.js";
import "./command-auth-native-BhcKSceK.js";
import "./channel-inbound-C7GtKjtG.js";
import { t as formatLocationText } from "./location-B0jdizlz.js";
import { t as resolveTelegramPreviewStreamMode } from "./preview-streaming-CpiesNih.js";
//#region extensions/telegram/src/outbound-params.ts
function parseIntegerId(value) {
	if (!/^-?\d+$/.test(value)) return;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function normalizeTelegramReplyToMessageId(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : void 0;
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? parseIntegerId(trimmed) : void 0;
}
function parseTelegramReplyToMessageId(replyToId) {
	return normalizeTelegramReplyToMessageId(replyToId);
}
function parseTelegramThreadId(threadId) {
	if (threadId == null) return;
	if (typeof threadId === "number") return Number.isFinite(threadId) ? Math.trunc(threadId) : void 0;
	const trimmed = threadId.trim();
	if (!trimmed) return;
	const topicMatch = /^-?\d+:topic:(\d+)$/.exec(trimmed);
	if (topicMatch) return parseIntegerId(topicMatch[1]);
	const scopedMatch = /^-?\d+:(-?\d+)$/.exec(trimmed);
	return parseIntegerId(scopedMatch ? scopedMatch[1] : trimmed);
}
//#endregion
//#region extensions/telegram/src/bot-access.ts
const warnedInvalidEntries = /* @__PURE__ */ new Set();
const log = createSubsystemLogger("telegram/bot-access");
function warnInvalidAllowFromEntries(entries) {
	if (process.env.VITEST || false) return;
	for (const entry of entries) {
		if (warnedInvalidEntries.has(entry)) continue;
		warnedInvalidEntries.add(entry);
		log.warn([
			"Invalid allowFrom entry:",
			JSON.stringify(entry),
			"- allowFrom/groupAllowFrom authorization expects numeric Telegram sender user IDs only.",
			"To allow a Telegram group or supergroup, add its negative chat ID under \"channels.telegram.groups\" instead.",
			"If you had \"@username\" entries, re-run setup (it resolves @username to IDs) or replace them manually."
		].join(" "));
	}
}
const normalizeAllowFrom = (list) => {
	const entries = (list ?? []).map((value) => normalizeOptionalString(String(value)) ?? "").filter(Boolean);
	const hasWildcard = entries.includes("*");
	const normalized = entries.filter((value) => value !== "*").map((value) => value.replace(/^(telegram|tg):/i, ""));
	const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
	if (invalidEntries.length > 0) warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
	return {
		entries: normalized.filter((value) => /^\d+$/.test(value)),
		hasWildcard,
		hasEntries: entries.length > 0,
		invalidEntries
	};
};
const normalizeDmAllowFromWithStore = (params) => normalizeAllowFrom(mergeDmAllowFromSources(params));
function resolveTelegramEffectiveDmPolicy(params) {
	if (!params.isGroup && params.groupConfig && "dmPolicy" in params.groupConfig) return params.groupConfig.dmPolicy ?? params.dmPolicy ?? "pairing";
	return params.dmPolicy ?? "pairing";
}
const isSenderAllowed = (params) => {
	const { allow, senderId } = params;
	return isSenderIdAllowed(allow, senderId, true);
};
//#endregion
//#region extensions/telegram/src/access-groups.ts
async function expandTelegramAllowFromWithAccessGroups(params) {
	const allowFrom = (params.allowFrom ?? []).map(String);
	const senderId = params.senderId?.trim() ?? "";
	const expanded = params.cfg && senderId ? await expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom,
		channel: "telegram",
		accountId: params.accountId ?? "default",
		senderId,
		isSenderAllowed: (candidateSenderId, allowEntries) => isSenderAllowed({
			allow: normalizeAllowFrom(allowEntries),
			senderId: candidateSenderId
		})
	}) : allowFrom;
	const originalEntries = new Set(allowFrom);
	return expanded.some((entry) => !originalEntries.has(entry)) ? expanded.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null) : expanded;
}
async function resolveTelegramDmAllow(params) {
	const allowFrom = params.groupAllowOverride ?? params.allowFrom;
	const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom,
		accountId: params.accountId,
		senderId: params.senderId
	});
	return {
		allowFrom,
		expandedAllowFrom,
		effectiveAllow: normalizeDmAllowFromWithStore({
			allowFrom: expandedAllowFrom,
			storeAllowFrom: params.storeAllowFrom,
			dmPolicy: params.dmPolicy
		})
	};
}
//#endregion
//#region extensions/telegram/src/bot/body-helpers.ts
function buildSenderName(msg) {
	return [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || msg.from?.username || void 0;
}
function resolveTelegramPrimaryMedia(msg) {
	if (!msg) return;
	const photo = msg.photo?.[msg.photo.length - 1];
	if (photo) return {
		placeholder: "<media:image>",
		fileRef: photo
	};
	if (msg.video) return {
		placeholder: "<media:video>",
		fileRef: msg.video
	};
	if (msg.video_note) return {
		placeholder: "<media:video>",
		fileRef: msg.video_note
	};
	if (msg.audio) return {
		placeholder: "<media:audio>",
		fileRef: msg.audio
	};
	if (msg.voice) return {
		placeholder: "<media:audio>",
		fileRef: msg.voice
	};
	if (msg.document) return {
		placeholder: "<media:document>",
		fileRef: msg.document
	};
	if (msg.sticker) return {
		placeholder: "<media:sticker>",
		fileRef: msg.sticker
	};
}
function resolveTelegramMediaPlaceholder(msg) {
	return resolveTelegramPrimaryMedia(msg)?.placeholder;
}
function buildSenderLabel(msg, senderId) {
	const name = buildSenderName(msg);
	const username = msg.from?.username ? `@${msg.from.username}` : void 0;
	let label = name;
	if (name && username) label = `${name} (${username})`;
	else if (!name && username) label = username;
	const fallbackId = (senderId != null ? normalizeOptionalString(String(senderId)) : void 0) ?? (msg.from?.id != null ? String(msg.from.id) : void 0);
	const idPart = fallbackId ? `id:${fallbackId}` : void 0;
	if (label && idPart) return `${label} ${idPart}`;
	if (label) return label;
	return idPart ?? "id:unknown";
}
function isBinaryContent(text) {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 31 && code !== 9 && code !== 10 && code !== 13) return true;
	}
	return false;
}
function resolveTelegramTextContent(text, caption) {
	const raw = typeof text === "string" ? text : typeof caption === "string" ? caption : "";
	return isBinaryContent(raw) ? "" : raw;
}
function getTelegramTextParts(msg) {
	const text = resolveTelegramTextContent(msg.text, msg.caption);
	return {
		text,
		entities: text ? msg.entities ?? msg.caption_entities ?? [] : []
	};
}
function isTelegramMentionWordChar(char) {
	return char != null && /[a-z0-9_]/i.test(char);
}
function hasStandaloneTelegramMention(text, mention) {
	let startIndex = 0;
	while (startIndex < text.length) {
		const idx = text.indexOf(mention, startIndex);
		if (idx === -1) return false;
		const prev = idx > 0 ? text[idx - 1] : void 0;
		const next = text[idx + mention.length];
		if (!isTelegramMentionWordChar(prev) && !isTelegramMentionWordChar(next)) return true;
		startIndex = idx + 1;
	}
	return false;
}
function hasBotMention(msg, botUsername) {
	const { text, entities } = getTelegramTextParts(msg);
	const mention = normalizeLowercaseStringOrEmpty(`@${botUsername}`);
	if (hasStandaloneTelegramMention(normalizeLowercaseStringOrEmpty(text), mention)) return true;
	for (const ent of entities) {
		if (ent.type !== "mention") continue;
		if (normalizeLowercaseStringOrEmpty(text.slice(ent.offset, ent.offset + ent.length)) === mention) return true;
	}
	return false;
}
function expandTextLinks(text, entities) {
	if (!text || !entities?.length) return text;
	const textLinks = entities.filter((entity) => entity.type === "text_link" && Boolean(entity.url)).toSorted((a, b) => b.offset - a.offset);
	if (textLinks.length === 0) return text;
	let result = text;
	for (const entity of textLinks) {
		const markdown = `[${text.slice(entity.offset, entity.offset + entity.length)}](${entity.url})`;
		result = result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
	}
	return result;
}
function normalizeForwardedUserLabel(user) {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	const username = normalizeOptionalString(user.username);
	const id = String(user.id);
	return {
		display: (name && username ? `${name} (@${username})` : name || (username ? `@${username}` : void 0)) || `user:${id}`,
		name: name || void 0,
		username,
		id
	};
}
function normalizeForwardedChatLabel(chat, fallbackKind) {
	const title = normalizeOptionalString(chat.title);
	const username = normalizeOptionalString(chat.username);
	const id = String(chat.id);
	return {
		display: title || (username ? `@${username}` : void 0) || `${fallbackKind}:${id}`,
		title,
		username,
		id
	};
}
function buildForwardedContextFromUser(params) {
	const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
	if (!display) return null;
	return {
		from: display,
		date: params.date,
		fromType: params.type,
		fromId: id,
		fromUsername: username,
		fromTitle: name
	};
}
function buildForwardedContextFromHiddenName(params) {
	const trimmed = params.name?.trim();
	if (!trimmed) return null;
	return {
		from: trimmed,
		date: params.date,
		fromType: params.type,
		fromTitle: trimmed
	};
}
function buildForwardedContextFromChat(params) {
	const fallbackKind = params.type === "channel" ? "channel" : "chat";
	const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
	if (!display) return null;
	const signature = normalizeOptionalString(params.signature);
	const from = signature ? `${display} (${signature})` : display;
	const chatType = normalizeOptionalString(params.chat.type);
	return {
		from,
		date: params.date,
		fromType: params.type,
		fromId: id,
		fromUsername: username,
		fromTitle: title,
		fromSignature: signature,
		fromChatType: chatType,
		fromMessageId: params.messageId
	};
}
function resolveForwardOrigin(origin) {
	switch (origin.type) {
		case "user": return buildForwardedContextFromUser({
			user: origin.sender_user,
			date: origin.date,
			type: "user"
		});
		case "hidden_user": return buildForwardedContextFromHiddenName({
			name: origin.sender_user_name,
			date: origin.date,
			type: "hidden_user"
		});
		case "chat": return buildForwardedContextFromChat({
			chat: origin.sender_chat,
			date: origin.date,
			type: "chat",
			signature: origin.author_signature
		});
		case "channel": return buildForwardedContextFromChat({
			chat: origin.chat,
			date: origin.date,
			type: "channel",
			signature: origin.author_signature,
			messageId: origin.message_id
		});
		default: return null;
	}
}
function normalizeForwardedContext(msg) {
	if (!msg.forward_origin) return null;
	return resolveForwardOrigin(msg.forward_origin);
}
function extractTelegramLocation(msg) {
	const { venue, location } = msg;
	if (venue) return {
		latitude: venue.location.latitude,
		longitude: venue.location.longitude,
		accuracy: venue.location.horizontal_accuracy,
		name: venue.title,
		address: venue.address,
		source: "place",
		isLive: false
	};
	if (location) {
		const isLive = typeof location.live_period === "number" && location.live_period > 0;
		return {
			latitude: location.latitude,
			longitude: location.longitude,
			accuracy: location.horizontal_accuracy,
			source: isLive ? "live" : "pin",
			isLive
		};
	}
	return null;
}
//#endregion
//#region extensions/telegram/src/bot/helpers.ts
const TELEGRAM_GENERAL_TOPIC_ID = 1;
const TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS = 1024;
const TELEGRAM_FORUM_FLAG_CACHE_TTL_MS = 10 * 6e4;
const telegramForumFlagByChatId = /* @__PURE__ */ new Map();
function resetTelegramForumFlagCacheForTest() {
	telegramForumFlagByChatId.clear();
}
function cacheTelegramForumFlag(chatId, isForum, nowMs = Date.now()) {
	const cacheKey = String(chatId);
	if (!telegramForumFlagByChatId.has(cacheKey) && telegramForumFlagByChatId.size >= TELEGRAM_FORUM_FLAG_CACHE_MAX_CHATS) {
		const oldestKey = telegramForumFlagByChatId.keys().next().value;
		if (oldestKey !== void 0) telegramForumFlagByChatId.delete(oldestKey);
	}
	telegramForumFlagByChatId.set(cacheKey, {
		expiresAtMs: nowMs + TELEGRAM_FORUM_FLAG_CACHE_TTL_MS,
		isForum
	});
}
function hadUnsafeTelegramText(raw, sanitized) {
	return typeof raw === "string" && raw.trim().length > 0 && sanitized.trim().length === 0;
}
function normalizeTelegramDmThreadReplies(value) {
	return value === "off" || value === "inbound" || value === "always" ? value : void 0;
}
function resolveTelegramDmThreadReplies(params) {
	return normalizeTelegramDmThreadReplies(params.directConfig?.threadReplies) ?? normalizeTelegramDmThreadReplies(params.accountConfig?.dm?.threadReplies) ?? "off";
}
function shouldUseTelegramDmThreadSession(params) {
	if (params.dmThreadId == null) return false;
	if (params.directConfig?.requireTopic === true || params.topicConfig) return true;
	return resolveTelegramDmThreadReplies(params) !== "off";
}
function extractTelegramForumFlag(value) {
	if (!value || typeof value !== "object" || !("is_forum" in value)) return;
	const forum = value.is_forum;
	return typeof forum === "boolean" ? forum : void 0;
}
function resolveTelegramMessageForumFlagHint(params) {
	if (params.chatType === "supergroup" && params.isTopicMessage === true) return true;
	return typeof params.isForum === "boolean" ? params.isForum : void 0;
}
async function resolveTelegramForumFlag(params) {
	const forumHint = resolveTelegramMessageForumFlagHint({
		chatType: params.chatType,
		isForum: params.isForum,
		isTopicMessage: params.isTopicMessage
	});
	if (typeof forumHint === "boolean") {
		if (params.isGroup && params.chatType === "supergroup") cacheTelegramForumFlag(params.chatId, forumHint);
		return forumHint;
	}
	if (!params.isGroup || params.chatType !== "supergroup" || !params.getChat) return false;
	const cacheKey = String(params.chatId);
	const nowMs = Date.now();
	const cached = telegramForumFlagByChatId.get(cacheKey);
	if (cached && cached.expiresAtMs > nowMs) return cached.isForum;
	if (cached) telegramForumFlagByChatId.delete(cacheKey);
	try {
		const resolved = extractTelegramForumFlag(await params.getChat(params.chatId)) === true;
		cacheTelegramForumFlag(params.chatId, resolved, nowMs);
		return resolved;
	} catch {
		return false;
	}
}
function withResolvedTelegramForumFlag(message, isForum) {
	if (extractTelegramForumFlag(message.chat) === isForum) return message;
	return {
		...message,
		chat: {
			...message.chat,
			is_forum: isForum
		}
	};
}
async function resolveTelegramGroupAllowFromContext(params) {
	const accountId = normalizeAccountId(params.accountId);
	const threadSpec = resolveTelegramThreadSpec({
		isGroup: params.isGroup ?? false,
		isForum: params.isForum,
		messageThreadId: params.messageThreadId
	});
	const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : void 0;
	const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
	const threadIdForConfig = resolvedThreadId ?? dmThreadId;
	const storeAllowFrom = await (params.readChannelAllowFromStore ?? readChannelAllowFromStore)("telegram", process.env, accountId).catch(() => []);
	const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(params.chatId, threadIdForConfig);
	const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
	return {
		resolvedThreadId,
		dmThreadId,
		storeAllowFrom,
		groupConfig,
		topicConfig,
		groupAllowOverride,
		effectiveGroupAllow: normalizeAllowFrom(await expandTelegramAllowFromWithAccessGroups({
			cfg: params.cfg,
			allowFrom: groupAllowOverride ?? params.groupAllowFrom,
			accountId,
			senderId: params.senderId
		})),
		hasGroupAllowOverride: groupAllowOverride !== void 0
	};
}
/**
* Resolve the thread ID for Telegram forum topics.
* For non-forum groups, returns undefined even if messageThreadId is present
* (reply threads in regular groups should not create separate sessions).
* For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
*/
function resolveTelegramForumThreadId(params) {
	if (!params.isForum) return;
	if (params.messageThreadId == null) return TELEGRAM_GENERAL_TOPIC_ID;
	return params.messageThreadId;
}
function resolveTelegramThreadSpec(params) {
	if (params.isGroup) return {
		id: resolveTelegramForumThreadId({
			isForum: params.isForum,
			messageThreadId: params.messageThreadId
		}),
		scope: params.isForum ? "forum" : "none"
	};
	if (params.messageThreadId == null) return { scope: "dm" };
	return {
		id: params.messageThreadId,
		scope: "dm"
	};
}
/**
* Build thread params for Telegram API calls (messages, media).
*
* IMPORTANT: Thread IDs behave differently based on chat type:
* - DMs (private chats): Include message_thread_id when present (DM topics)
* - Forum topics: Skip thread_id=1 (General topic), include others
* - Regular groups: Thread IDs are ignored by Telegram
*
* General forum topic (id=1) must be treated like a regular supergroup send:
* Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
*
* @param thread - Thread specification with ID and scope
* @returns API params object or undefined if thread_id should be omitted
*/
function buildTelegramThreadParams(thread) {
	if (thread?.id == null) return;
	const normalized = Math.trunc(thread.id);
	if (thread.scope === "dm") return normalized > 0 ? { message_thread_id: normalized } : void 0;
	if (normalized === TELEGRAM_GENERAL_TOPIC_ID) return;
	return { message_thread_id: normalized };
}
/**
* Build a Telegram routing target that keeps real topic/thread ids in-band.
*
* This is used by generic reply plumbing that may not always carry a separate
* `threadId` field through every hop. General forum topic stays chat-scoped
* because Telegram rejects `message_thread_id=1` for message sends.
*/
function buildTelegramRoutingTarget(chatId, thread) {
	const base = `telegram:${chatId}`;
	const messageThreadId = buildTelegramThreadParams(thread)?.message_thread_id;
	if (typeof messageThreadId !== "number") return base;
	return `${base}:topic:${messageThreadId}`;
}
/**
* Build the canonical Telegram inbound origin used by queued follow-up routing.
* DM thread ids remain metadata-only; real forum topics must be in-band.
*/
function buildTelegramInboundOriginTarget(chatId, thread) {
	if (thread?.scope !== "forum") return `telegram:${chatId}`;
	return buildTelegramRoutingTarget(chatId, thread);
}
/**
* Build thread params for typing indicators (sendChatAction).
* Empirically, General topic (id=1) needs message_thread_id for typing to appear.
*/
function buildTypingThreadParams(messageThreadId) {
	if (messageThreadId == null) return;
	return { message_thread_id: Math.trunc(messageThreadId) };
}
function resolveTelegramStreamMode(telegramCfg) {
	return resolveTelegramPreviewStreamMode(telegramCfg);
}
function buildTelegramGroupPeerId(chatId, messageThreadId) {
	return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}
/**
* Resolve the direct-message peer identifier for Telegram routing/session keys.
*
* In some Telegram DM deliveries (for example certain business/chat bridge flows),
* `chat.id` can differ from the actual sender user id. Prefer sender id when present
* so per-peer DM scopes isolate users correctly.
*/
function resolveTelegramDirectPeerId(params) {
	const senderId = params.senderId != null ? normalizeOptionalString(String(params.senderId)) ?? "" : "";
	if (senderId) return senderId;
	return String(params.chatId);
}
function buildTelegramGroupFrom(chatId, messageThreadId) {
	return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}
function isTelegramCommandsAllowFromConfigured(cfg) {
	const commandsAllowFrom = cfg.commands?.allowFrom;
	return commandsAllowFrom != null && typeof commandsAllowFrom === "object" && (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
}
function resolveTelegramCommandAuthorization(params) {
	return resolveCommandAuthorization({
		ctx: {
			Provider: "telegram",
			Surface: "telegram",
			OriginatingChannel: "telegram",
			AccountId: params.accountId,
			ChatType: params.isGroup ? "group" : "direct",
			From: params.isGroup ? buildTelegramGroupFrom(params.chatId, params.resolvedThreadId) : `telegram:${params.chatId}`,
			SenderId: params.senderId || void 0,
			SenderUsername: params.senderUsername || void 0
		},
		cfg: params.cfg,
		commandAuthorized: false
	});
}
/**
* Build parentPeer for forum topic binding inheritance.
* When a message comes from a forum topic, the peer ID includes the topic suffix
* (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
* group ID to match, we provide the parent group as `parentPeer` so the routing
* layer can fall back to it when the exact peer doesn't match.
*/
function buildTelegramParentPeer(params) {
	if (!params.isGroup || params.resolvedThreadId == null) return;
	return {
		kind: "group",
		id: String(params.chatId)
	};
}
function buildGroupLabel(msg, chatId, messageThreadId) {
	const title = msg.chat?.title;
	const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
	if (title) return `${title} id:${chatId}${topicSuffix}`;
	return `group:${chatId}${topicSuffix}`;
}
function resolveTelegramReplyId(raw) {
	return normalizeTelegramReplyToMessageId(raw);
}
function describeReplyTarget(msg) {
	const reply = msg.reply_to_message;
	const externalReply = msg.external_reply;
	const quote = msg.quote ?? externalReply?.quote;
	const rawQuoteText = quote?.text;
	const quoteText = resolveTelegramTextContent(rawQuoteText);
	let body = "";
	let kind = "reply";
	const filteredQuoteText = hadUnsafeTelegramText(rawQuoteText, quoteText);
	body = quoteText.trim();
	if (body) kind = "quote";
	const replyLike = reply ?? externalReply;
	const rawReplyText = replyLike && typeof replyLike.text === "string" ? replyLike.text : replyLike && typeof replyLike.caption === "string" ? replyLike.caption : void 0;
	const safeReplyText = resolveTelegramTextContent(rawReplyText);
	const replyTextParts = replyLike && safeReplyText ? getTelegramTextParts(replyLike) : void 0;
	let filteredReplyText = false;
	if (!body && replyLike) {
		const replyBody = safeReplyText.trim();
		filteredReplyText = hadUnsafeTelegramText(rawReplyText, replyBody);
		body = replyBody;
		if (!body) {
			body = resolveTelegramMediaPlaceholder(replyLike) ?? "";
			if (!body) {
				const locationData = extractTelegramLocation(replyLike);
				if (locationData) body = formatLocationText(locationData);
			}
		}
	}
	if (!body && !replyLike) return null;
	if (!body && !filteredQuoteText && !filteredReplyText) return null;
	const senderLabel = (replyLike ? buildSenderName(replyLike) : void 0) ?? "unknown sender";
	const source = reply ? "reply_to_message" : "external_reply";
	const quotePosition = kind === "quote" && typeof quote?.position === "number" && Number.isFinite(quote.position) ? Math.trunc(quote.position) : void 0;
	const quoteEntities = kind === "quote" && Array.isArray(quote?.entities) ? quote.entities : void 0;
	const forwardedFrom = replyLike ? normalizeForwardedContext(replyLike) ?? void 0 : void 0;
	return {
		id: replyLike?.message_id ? String(replyLike.message_id) : void 0,
		sender: senderLabel,
		senderId: replyLike?.from?.id != null ? String(replyLike.from.id) : void 0,
		senderUsername: replyLike?.from?.username ?? void 0,
		body: body || void 0,
		kind,
		source,
		quoteText: kind === "quote" ? quoteText : void 0,
		quotePosition,
		quoteEntities,
		forwardedFrom,
		quoteSourceText: replyTextParts?.text || void 0,
		quoteSourceEntities: replyTextParts?.entities
	};
}
//#endregion
//#region extensions/telegram/src/format.ts
function escapeTelegramHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtml(text) {
	return escapeTelegramHtml(text);
}
function escapeHtmlAttr(text) {
	return escapeHtml(text).replace(/"/g, "&quot;");
}
/**
* File extensions that share TLDs and commonly appear in code/documentation.
* These are wrapped in <code> tags to prevent Telegram from generating
* spurious domain registrar previews.
*
* Only includes extensions that are:
* 1. Commonly used as file extensions in code/docs
* 2. Rarely used as intentional domain references
*
* Excluded: .ai, .io, .tv, .fm (popular domain TLDs like x.ai, vercel.io, github.io)
*/
function buildTelegramLink(link, text) {
	const href = link.href.trim();
	if (!href) return null;
	if (link.start === link.end) return null;
	if (isAutoLinkedFileRef(href, text.slice(link.start, link.end))) return null;
	const safeHref = escapeHtmlAttr(href);
	return {
		start: link.start,
		end: link.end,
		open: `<a href="${safeHref}">`,
		close: "</a>"
	};
}
function buildTelegramCodeBlockOpen(span) {
	if (!span.language) return "<pre><code>";
	return `<pre><code class="language-${escapeHtmlAttr(span.language)}">`;
}
function renderTelegramHtml(ir) {
	return renderMarkdownWithMarkers(ir, {
		styleMarkers: {
			bold: {
				open: "<b>",
				close: "</b>"
			},
			italic: {
				open: "<i>",
				close: "</i>"
			},
			strikethrough: {
				open: "<s>",
				close: "</s>"
			},
			code: {
				open: "<code>",
				close: "</code>"
			},
			code_block: {
				open: buildTelegramCodeBlockOpen,
				close: "</code></pre>"
			},
			spoiler: {
				open: "<tg-spoiler>",
				close: "</tg-spoiler>"
			},
			blockquote: {
				open: "<blockquote>",
				close: "</blockquote>"
			}
		},
		escapeText: escapeHtml,
		buildLink: buildTelegramLink
	});
}
function leadingWhitespaceLength(line) {
	let length = 0;
	while (line[length] === " " || line[length] === "	") length++;
	return length;
}
function isTelegramBulletLine(line) {
	return /^[ \t]*(?:[•*+-])[ \t]+\S/.test(line);
}
function isTelegramListBoundaryLine(line) {
	return /^[ \t]*(?:\d+\.|#{1,6})[ \t]+\S/.test(line);
}
function isMarkdownIndentedCodeLine(line) {
	return /^(?: {4}|\t)/.test(line);
}
function shouldPreserveTelegramListBoundarySpacing(previous, next) {
	return !isMarkdownIndentedCodeLine(previous) && !isMarkdownIndentedCodeLine(next) && isTelegramBulletLine(previous) && isTelegramListBoundaryLine(next) && leadingWhitespaceLength(next) <= leadingWhitespaceLength(previous);
}
function preserveTelegramListBoundarySpacing(markdown) {
	const lines = markdown.split("\n");
	const out = [];
	let inFence = false;
	let previousLine = "";
	for (const line of lines) {
		const normalizedLine = line.replace(/\r$/, "");
		const isFenceLine = /^[ \t]*(?:```|~~~)/.test(normalizedLine);
		if (!inFence && shouldPreserveTelegramListBoundarySpacing(previousLine, normalizedLine)) out.push("");
		out.push(line);
		if (isFenceLine) inFence = !inFence;
		previousLine = normalizedLine;
	}
	return out.join("\n");
}
function markdownToTelegramHtml(markdown, options = {}) {
	const telegramHtml = preserveSupportedTelegramHtmlTags(renderTelegramHtml(markdownToIR(preserveTelegramListBoundarySpacing(markdown ?? ""), {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	})));
	if (options.wrapFileRefs !== false) return wrapFileReferencesInHtml(telegramHtml);
	return telegramHtml;
}
/**
* Wraps standalone file references (with TLD extensions) in <code> tags.
* This prevents Telegram from treating them as URLs and generating
* irrelevant domain registrar previews.
*
* Runs AFTER markdown→HTML conversion to avoid modifying HTML attributes.
* Skips content inside <code>, <pre>, and <a> tags to avoid nesting issues.
*/
/** Escape regex metacharacters in a string */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const AUTO_LINKED_ANCHOR_PATTERN = /<a\s+href="https?:\/\/([^"]+)"[^>]*>\1<\/a>/gi;
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;
const HTML_MODE_TAG_PATTERN = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>$/;
const ESCAPED_HTML_TAG_PATTERN = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)(.*?)&gt;/g;
const TELEGRAM_HTML_ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const TELEGRAM_HTML_BREAK_PATTERN = /<br\s*\/?>/gi;
const TELEGRAM_HTML_ENTITY_PATTERN = /&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g;
const TELEGRAM_HTML_TAG_PATTERN = /<[^>]*>/g;
const TELEGRAM_SIMPLE_HTML_TAGS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"ins",
	"s",
	"strike",
	"del",
	"code",
	"pre",
	"tg-spoiler",
	"blockquote"
]);
const TELEGRAM_ATTR_HTML_TAG_PATTERNS = new Map([
	["a", /^\s+href="[^"]+"\s*$/],
	["span", /^\s+class="tg-spoiler"\s*$/],
	["tg-emoji", /^\s+emoji-id="[^"]+"\s*$/],
	["tg-time", /^\s+datetime="[^"]+"\s*$/]
]);
let fileReferencePattern;
let orphanedTldPattern;
function popLastTagName(tags, name) {
	for (let index = tags.length - 1; index >= 0; index -= 1) if (tags[index] === name) {
		tags.splice(index, 1);
		return true;
	}
	return false;
}
function isSupportedTelegramHtmlTag(rawTag) {
	const match = HTML_MODE_TAG_PATTERN.exec(rawTag);
	if (!match) return false;
	const closing = match[1] === "/";
	const name = normalizeLowercaseStringOrEmpty(match[2]);
	const attrs = match[3] ?? "";
	if (TELEGRAM_SIMPLE_HTML_TAGS.has(name)) return attrs.trim() === "";
	if (closing) return attrs.trim() === "";
	return TELEGRAM_ATTR_HTML_TAG_PATTERNS.get(name)?.test(attrs) ?? false;
}
function preserveTelegramHtmlTag(rawTag, openTags, escapeTag) {
	const match = HTML_MODE_TAG_PATTERN.exec(rawTag);
	if (!match || !isSupportedTelegramHtmlTag(rawTag)) return escapeTag(rawTag);
	const closing = match[1] === "/";
	const tagName = normalizeLowercaseStringOrEmpty(match[2]);
	if (closing) return popLastTagName(openTags, tagName) ? rawTag : escapeTag(rawTag);
	openTags.push(tagName);
	return rawTag;
}
function escapeUnsupportedTelegramHtml(text) {
	let result = "";
	let index = 0;
	const openTags = [];
	while (index < text.length) {
		const char = text[index];
		if (char === "&") {
			const entityEnd = findTelegramHtmlEntityEnd(text, index);
			if (entityEnd !== -1) {
				result += text.slice(index, entityEnd + 1);
				index = entityEnd + 1;
			} else {
				result += "&amp;";
				index += 1;
			}
			continue;
		}
		if (char === "<") {
			const end = text.indexOf(">", index + 1);
			if (end !== -1) {
				const rawTag = text.slice(index, end + 1);
				result += preserveTelegramHtmlTag(rawTag, openTags, escapeHtml);
				index = end + 1;
			} else {
				result += "&lt;";
				index += 1;
			}
			continue;
		}
		if (char === ">") {
			result += "&gt;";
			index += 1;
			continue;
		}
		result += char;
		index += 1;
	}
	return result;
}
function decodeTelegramHtmlEntity(entity, fallback) {
	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		const codePoint = Number.parseInt(entity.slice(2), 16);
		return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : fallback;
	}
	if (entity.startsWith("#")) {
		const codePoint = Number.parseInt(entity.slice(1), 10);
		return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : fallback;
	}
	switch (entity) {
		case "amp": return "&";
		case "lt": return "<";
		case "gt": return ">";
		case "quot": return "\"";
		case "apos": return "'";
		default: return fallback;
	}
}
function decodeTelegramHtmlEntities(text) {
	return text.replace(TELEGRAM_HTML_ENTITY_PATTERN, (match, entity) => decodeTelegramHtmlEntity(entity, match));
}
function stripTelegramHtmlForPlainText(html) {
	return decodeTelegramHtmlEntities(html.replace(TELEGRAM_HTML_BREAK_PATTERN, "\n").replace(TELEGRAM_HTML_TAG_PATTERN, ""));
}
function encodePlainTextForTelegramHtmlStrip(text) {
	return text.replace(/[&<>]/g, (char) => {
		switch (char) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			default: return char;
		}
	});
}
function telegramHtmlToPlainTextFallback(html) {
	TELEGRAM_HTML_ANCHOR_PATTERN.lastIndex = 0;
	return stripTelegramHtmlForPlainText(html.replace(TELEGRAM_HTML_ANCHOR_PATTERN, (_match, doubleQuotedHref, singleQuotedHref, unquotedHref, labelHtml) => {
		const href = decodeTelegramHtmlEntities(doubleQuotedHref ?? singleQuotedHref ?? unquotedHref ?? "").trim();
		const label = stripTelegramHtmlForPlainText(labelHtml).trim();
		if (!href) return encodePlainTextForTelegramHtmlStrip(label);
		return encodePlainTextForTelegramHtmlStrip(!label || label === href ? href : `${label} (${href})`);
	}));
}
function promoteEscapedSupportedTelegramTags(text, openTags) {
	ESCAPED_HTML_TAG_PATTERN.lastIndex = 0;
	return text.replace(ESCAPED_HTML_TAG_PATTERN, (match, closing, name, attrs) => preserveTelegramHtmlTag(`<${closing}${name}${attrs}>`, openTags, () => match));
}
function preserveSupportedTelegramHtmlTags(html) {
	let codeDepth = 0;
	let preDepth = 0;
	let result = "";
	let lastIndex = 0;
	const openEscapedTags = [];
	HTML_TAG_PATTERN.lastIndex = 0;
	let match;
	while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
		const tagStart = match.index;
		const tagEnd = HTML_TAG_PATTERN.lastIndex;
		const tagName = normalizeLowercaseStringOrEmpty(match[2]);
		const isClosing = match[1] === "</";
		const textBefore = html.slice(lastIndex, tagStart);
		result += codeDepth > 0 || preDepth > 0 ? textBefore : promoteEscapedSupportedTelegramTags(textBefore, openEscapedTags);
		if (tagName === "code") codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
		else if (tagName === "pre") preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
		result += html.slice(tagStart, tagEnd);
		lastIndex = tagEnd;
	}
	const remainingText = html.slice(lastIndex);
	result += codeDepth > 0 || preDepth > 0 ? remainingText : promoteEscapedSupportedTelegramTags(remainingText, openEscapedTags);
	return result;
}
function getFileReferencePattern() {
	if (fileReferencePattern) return fileReferencePattern;
	const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
	fileReferencePattern = new RegExp(`(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${fileExtensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`, "gi");
	return fileReferencePattern;
}
function getOrphanedTldPattern() {
	if (orphanedTldPattern) return orphanedTldPattern;
	const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
	orphanedTldPattern = new RegExp(`([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${fileExtensionsPattern}))(?=[^a-zA-Z0-9/]|$)`, "g");
	return orphanedTldPattern;
}
function wrapStandaloneFileRef(match, prefix, filename) {
	if (filename.startsWith("//")) return match;
	if (/https?:\/\/$/i.test(prefix)) return match;
	return `${prefix}<code>${escapeHtml(filename)}</code>`;
}
function wrapSegmentFileRefs(text, codeDepth, preDepth, anchorDepth) {
	if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) return text;
	return text.replace(getFileReferencePattern(), wrapStandaloneFileRef).replace(getOrphanedTldPattern(), (match, prefix, tld) => prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`);
}
function wrapFileReferencesInHtml(html) {
	AUTO_LINKED_ANCHOR_PATTERN.lastIndex = 0;
	const deLinkified = html.replace(AUTO_LINKED_ANCHOR_PATTERN, (_match, label) => {
		if (!isAutoLinkedFileRef(`http://${label}`, label)) return _match;
		return `<code>${escapeHtml(label)}</code>`;
	});
	let codeDepth = 0;
	let preDepth = 0;
	let anchorDepth = 0;
	let result = "";
	let lastIndex = 0;
	HTML_TAG_PATTERN.lastIndex = 0;
	let match;
	while ((match = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
		const tagStart = match.index;
		const tagEnd = HTML_TAG_PATTERN.lastIndex;
		const isClosing = match[1] === "</";
		const tagName = normalizeLowercaseStringOrEmpty(match[2]);
		const textBefore = deLinkified.slice(lastIndex, tagStart);
		result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);
		if (tagName === "code") codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
		else if (tagName === "pre") preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
		else if (tagName === "a") anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
		result += deLinkified.slice(tagStart, tagEnd);
		lastIndex = tagEnd;
	}
	const remainingText = deLinkified.slice(lastIndex);
	result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);
	return result;
}
function renderTelegramHtmlText(text, options = {}) {
	if ((options.textMode ?? "markdown") === "html") return escapeUnsupportedTelegramHtml(text);
	return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}
const TELEGRAM_SELF_CLOSING_HTML_TAGS = new Set(["br"]);
function buildTelegramHtmlOpenPrefix(tags) {
	return tags.map((tag) => tag.openTag).join("");
}
function buildTelegramHtmlCloseSuffix(tags) {
	return tags.slice().toReversed().map((tag) => tag.closeTag).join("");
}
function buildTelegramHtmlCloseSuffixLength(tags) {
	return tags.reduce((total, tag) => total + tag.closeTag.length, 0);
}
function findTelegramHtmlEntityEnd(text, start) {
	if (text[start] !== "&") return -1;
	let index = start + 1;
	if (index >= text.length) return -1;
	if (text[index] === "#") {
		index += 1;
		if (index >= text.length) return -1;
		if (text[index] === "x" || text[index] === "X") {
			index += 1;
			const hexStart = index;
			while (/[0-9A-Fa-f]/.test(text[index] ?? "")) index += 1;
			if (index === hexStart) return -1;
		} else {
			const digitStart = index;
			while (/[0-9]/.test(text[index] ?? "")) index += 1;
			if (index === digitStart) return -1;
		}
	} else {
		const nameStart = index;
		while (/[A-Za-z0-9]/.test(text[index] ?? "")) index += 1;
		if (index === nameStart) return -1;
	}
	return text[index] === ";" ? index : -1;
}
function findTelegramHtmlSafeSplitIndex(text, maxLength) {
	if (text.length <= maxLength) return text.length;
	const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
	const lastAmpersand = text.lastIndexOf("&", normalizedMaxLength - 1);
	if (lastAmpersand === -1) return normalizedMaxLength;
	if (lastAmpersand < text.lastIndexOf(";", normalizedMaxLength - 1)) return normalizedMaxLength;
	const entityEnd = findTelegramHtmlEntityEnd(text, lastAmpersand);
	if (entityEnd === -1 || entityEnd < normalizedMaxLength) return normalizedMaxLength;
	return lastAmpersand;
}
function popTelegramHtmlTag(tags, name) {
	for (let index = tags.length - 1; index >= 0; index -= 1) if (tags[index]?.name === name) {
		tags.splice(index, 1);
		return;
	}
}
function splitTelegramHtmlChunks(html, limit) {
	if (!html) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	if (html.length <= normalizedLimit) return [html];
	const chunks = [];
	const openTags = [];
	let current = "";
	let chunkHasPayload = false;
	const resetCurrent = () => {
		current = buildTelegramHtmlOpenPrefix(openTags);
		chunkHasPayload = false;
	};
	const flushCurrent = () => {
		if (!chunkHasPayload) return;
		chunks.push(`${current}${buildTelegramHtmlCloseSuffix(openTags)}`);
		resetCurrent();
	};
	const appendText = (segment) => {
		let remaining = segment;
		while (remaining.length > 0) {
			const available = normalizedLimit - current.length - buildTelegramHtmlCloseSuffixLength(openTags);
			if (available <= 0) {
				if (!chunkHasPayload) throw new Error(`Telegram HTML chunk limit exceeded by tag overhead (limit=${normalizedLimit})`);
				flushCurrent();
				continue;
			}
			if (remaining.length <= available) {
				current += remaining;
				chunkHasPayload = true;
				break;
			}
			const splitAt = findTelegramHtmlSafeSplitIndex(remaining, available);
			if (splitAt <= 0) {
				if (!chunkHasPayload) throw new Error(`Telegram HTML chunk limit exceeded by leading entity (limit=${normalizedLimit})`);
				flushCurrent();
				continue;
			}
			current += remaining.slice(0, splitAt);
			chunkHasPayload = true;
			remaining = remaining.slice(splitAt);
			flushCurrent();
		}
	};
	resetCurrent();
	HTML_TAG_PATTERN.lastIndex = 0;
	let lastIndex = 0;
	let match;
	while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
		const tagStart = match.index;
		const tagEnd = HTML_TAG_PATTERN.lastIndex;
		appendText(html.slice(lastIndex, tagStart));
		const rawTag = match[0];
		const isClosing = match[1] === "</";
		const tagName = normalizeLowercaseStringOrEmpty(match[2]);
		const isSelfClosing = !isClosing && (TELEGRAM_SELF_CLOSING_HTML_TAGS.has(tagName) || rawTag.trimEnd().endsWith("/>"));
		if (!isClosing) {
			const nextCloseLength = isSelfClosing ? 0 : `</${tagName}>`.length;
			if (chunkHasPayload && current.length + rawTag.length + buildTelegramHtmlCloseSuffixLength(openTags) + nextCloseLength > normalizedLimit) flushCurrent();
		}
		current += rawTag;
		if (isSelfClosing) chunkHasPayload = true;
		if (isClosing) popTelegramHtmlTag(openTags, tagName);
		else if (!isSelfClosing) openTags.push({
			name: tagName,
			openTag: rawTag,
			closeTag: `</${tagName}>`
		});
		lastIndex = tagEnd;
	}
	appendText(html.slice(lastIndex));
	flushCurrent();
	return chunks.length > 0 ? chunks : [html];
}
function renderTelegramChunkHtml(ir) {
	return wrapFileReferencesInHtml(preserveSupportedTelegramHtmlTags(renderTelegramHtml(ir)));
}
function renderTelegramChunksWithinHtmlLimit(ir, limit) {
	return renderMarkdownIRChunksWithinLimit({
		ir,
		limit,
		renderChunk: renderTelegramChunkHtml,
		measureRendered: (html) => html.length
	}).map(({ source, rendered }) => ({
		html: rendered,
		text: source.text
	}));
}
function markdownToTelegramChunks(markdown, limit, options = {}) {
	return renderTelegramChunksWithinHtmlLimit(markdownToIR(preserveTelegramListBoundarySpacing(markdown ?? ""), {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	}), limit);
}
function markdownToTelegramHtmlChunks(markdown, limit, options = {}) {
	return markdownToTelegramChunks(markdown, limit, options).map((chunk) => chunk.html);
}
//#endregion
export { shouldUseTelegramDmThreadSession as A, resolveTelegramMediaPlaceholder as B, resolveTelegramForumFlag as C, resolveTelegramReplyId as D, resolveTelegramMessageForumFlagHint as E, extractTelegramLocation as F, normalizeAllowFrom as G, expandTelegramAllowFromWithAccessGroups as H, getTelegramTextParts as I, normalizeTelegramReplyToMessageId as J, normalizeDmAllowFromWithStore as K, hasBotMention as L, buildSenderLabel as M, buildSenderName as N, resolveTelegramStreamMode as O, expandTextLinks as P, isBinaryContent as R, resolveTelegramDirectPeerId as S, resolveTelegramGroupAllowFromContext as T, resolveTelegramDmAllow as U, resolveTelegramPrimaryMedia as V, isSenderAllowed as W, parseTelegramThreadId as X, parseTelegramReplyToMessageId as Y, describeReplyTarget as _, renderTelegramHtmlText as a, resetTelegramForumFlagCacheForTest as b, wrapFileReferencesInHtml as c, buildTelegramGroupPeerId as d, buildTelegramInboundOriginTarget as f, buildTypingThreadParams as g, buildTelegramThreadParams as h, markdownToTelegramHtmlChunks as i, withResolvedTelegramForumFlag as j, resolveTelegramThreadSpec as k, buildGroupLabel as l, buildTelegramRoutingTarget as m, markdownToTelegramChunks as n, splitTelegramHtmlChunks as o, buildTelegramParentPeer as p, resolveTelegramEffectiveDmPolicy as q, markdownToTelegramHtml as r, telegramHtmlToPlainTextFallback as s, escapeTelegramHtml as t, buildTelegramGroupFrom as u, extractTelegramForumFlag as v, resolveTelegramForumThreadId as w, resolveTelegramCommandAuthorization as x, isTelegramCommandsAllowFromConfigured as y, normalizeForwardedContext as z };
