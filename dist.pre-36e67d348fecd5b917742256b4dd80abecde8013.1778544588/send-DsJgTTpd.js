import { i as redactSensitiveText } from "./redact-1fZUZMlV.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { a as formatUncaughtError, c as readErrorName, i as formatErrorMessage, r as extractErrorCode, t as collectErrorGraphCandidates } from "./errors-QN8rySzW.js";
import { n as normalizeAccountId } from "./account-id-Bj7l9NI7.js";
import { t as isDiagnosticFlagEnabled } from "./diagnostic-flags-Ckplz1Fx.js";
import { t as createSubsystemLogger } from "./subsystem-DNg_cpPU.js";
import { r as logVerbose } from "./globals-BHVmraBM.js";
import { d as readConfigFileSnapshotForWrite } from "./io-C04VWQdx.js";
import { r as replaceConfigFile } from "./mutate-D5WWJ2kC.js";
import { d as resolveStorePath } from "./paths-Dai9rPIo.js";
import { c as kindFromMime, s as isGifMedia } from "./mime-DXu61ldU.js";
import { a as getImageMetadata } from "./image-ops-C9ZeTmtk.js";
import { t as loadWebMedia } from "./web-media-CSJcyrLp.js";
import { r as makeProxyFetch } from "./proxy-fetch-fh7Rifg6.js";
import { n as normalizePollInput } from "./polls-BT8uAfT3.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-CHC2v7Pz.js";
import { i as saveCronStore, r as resolveCronStorePath, t as loadCronStore } from "./store-BMUHYfpl.js";
import { i as markdownToIR, n as renderMarkdownWithMarkers } from "./tables-Cesh3j7-.js";
import { i as renderMarkdownIRChunksWithinLimit } from "./text-runtime-FOsx_CPC.js";
import { n as isAutoLinkedFileRef, t as FILE_REF_EXTENSIONS_WITH_TLD } from "./auto-linked-file-ref-_NlnSXzk.js";
import "./routing-DfF4_bqH.js";
import "./error-runtime-RY0qqoh6.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DyrWTyXN.js";
import { n as recordChannelActivity } from "./channel-activity-EMJPRkrk.js";
import { a as readChannelAllowFromStore } from "./pairing-store-DM-cQi74.js";
import { r as isVoiceCompatibleAudio } from "./audio-B8ztgqTR.js";
import { n as isSenderIdAllowed, r as mergeDmAllowFromSources, t as firstDefined } from "./allow-from-CI_a5-F_.js";
import "./runtime-env-DyZrKYOx.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-BANFJK51.js";
import "./config-mutation-BXOFvz9V.js";
import "./cron-store-runtime-R1dSGSG-.js";
import "./web-media-D6vibJc1.js";
import { n as createChannelApiRetryRunner } from "./retry-policy-QgYDkvzt.js";
import "./ssrf-runtime-Cup62pw7.js";
import { o as probeVideoDimensions } from "./media-runtime-Doi16sSJ.js";
import "./conversation-runtime-WRmNcyfY.js";
import { i as resolveAccessGroupAllowFromMatches, r as parseAccessGroupAllowFromEntry } from "./access-groups-7z8n_dSr.js";
import "./markdown-table-runtime-BFElE-2D.js";
import "./command-auth-oYbsjyAn.js";
import "./diagnostic-runtime-CCE_V1DD.js";
import "./channel-inbound-CtPTvcjp.js";
import { t as formatLocationText } from "./location-BmmNXev9.js";
import "./session-store-runtime-CYNftfYH.js";
import "./retry-runtime-D3g0KFup.js";
import { o as resolveTelegramAccount } from "./accounts-DONRqDdc.js";
import { n as resolveTelegramFetch, o as normalizeTelegramApiRoot } from "./fetch-B2pi5YlS.js";
import { t as resolveTelegramPreviewStreamMode } from "./preview-streaming-C-4hL-v0.js";
import fs from "node:fs";
import path from "node:path";
import * as grammy from "grammy";
import { Bot, HttpError } from "grammy";
//#region extensions/telegram/src/targets.ts
const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;
function stripTelegramInternalPrefixes(to) {
	let trimmed = to.trim();
	let strippedTelegramPrefix = false;
	while (true) {
		const next = (() => {
			if (/^(telegram|tg):/i.test(trimmed)) {
				strippedTelegramPrefix = true;
				return trimmed.replace(/^(telegram|tg):/i, "").trim();
			}
			if (strippedTelegramPrefix && /^group:/i.test(trimmed)) return trimmed.replace(/^group:/i, "").trim();
			return trimmed;
		})();
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}
function normalizeTelegramChatId(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) return stripped;
}
function isNumericTelegramChatId(raw) {
	return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}
function normalizeTelegramLookupTarget(raw) {
	const stripped = stripTelegramInternalPrefixes(raw);
	if (!stripped) return;
	if (isNumericTelegramChatId(stripped)) return stripped;
	const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
	if (tmeMatch?.[1]) return `@${tmeMatch[1]}`;
	if (stripped.startsWith("@")) {
		const handle = stripped.slice(1);
		if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) return;
		return `@${handle}`;
	}
	if (TELEGRAM_USERNAME_REGEX.test(stripped)) return `@${stripped}`;
}
/**
* Parse a Telegram delivery target into chatId and optional topic/thread ID.
*
* Supported formats:
* - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
* - `chatId:topicId` (numeric topic/thread ID)
* - `chatId:topic:topicId` (explicit topic marker; preferred)
*/
function resolveTelegramChatType(chatId) {
	const trimmed = chatId.trim();
	if (!trimmed) return "unknown";
	if (isNumericTelegramChatId(trimmed)) return trimmed.startsWith("-") ? "group" : "direct";
	return "unknown";
}
function parseTelegramTarget(to) {
	const normalized = stripTelegramInternalPrefixes(to);
	const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
	if (topicMatch) return {
		chatId: topicMatch[1],
		messageThreadId: Number.parseInt(topicMatch[2], 10),
		chatType: resolveTelegramChatType(topicMatch[1])
	};
	const colonMatch = /^(.+):(\d+)$/.exec(normalized);
	if (colonMatch) return {
		chatId: colonMatch[1],
		messageThreadId: Number.parseInt(colonMatch[2], 10),
		chatType: resolveTelegramChatType(colonMatch[1])
	};
	return {
		chatId: normalized,
		chatType: resolveTelegramChatType(normalized)
	};
}
function resolveTelegramTargetChatType(target) {
	return parseTelegramTarget(target).chatType;
}
//#endregion
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
const isSenderAllowed = (params) => {
	const { allow, senderId } = params;
	return isSenderIdAllowed(allow, senderId, true);
};
async function expandTelegramAllowFromWithAccessGroups(params) {
	const allowFrom = (params.allowFrom ?? []).map(String);
	if (!params.senderId) return allowFrom;
	const matched = await resolveAccessGroupAllowFromMatches({
		cfg: params.cfg,
		allowFrom,
		channel: "telegram",
		accountId: params.accountId ?? "default",
		senderId: params.senderId,
		isSenderAllowed: (senderId, entries) => isSenderAllowed({
			allow: normalizeAllowFrom(entries),
			senderId
		})
	});
	if (matched.length === 0) return allowFrom;
	const matchedGroups = new Set(matched);
	const expanded = allowFrom.filter((entry) => {
		const groupName = parseAccessGroupAllowFromEntry(entry);
		return groupName == null || !matchedGroups.has(`accessGroup:${groupName}`);
	});
	return Array.from(new Set([...expanded, params.senderId]));
}
const resolveSenderAllowMatch = (params) => {
	const { allow, senderId } = params;
	if (allow.hasWildcard) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	if (!allow.hasEntries) return { allowed: false };
	if (senderId && allow.entries.includes(senderId)) return {
		allowed: true,
		matchKey: senderId,
		matchSource: "id"
	};
	return { allowed: false };
};
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
async function resolveTelegramForumFlag(params) {
	if (typeof params.isForum === "boolean") {
		if (params.isGroup && params.chatType === "supergroup") cacheTelegramForumFlag(params.chatId, params.isForum);
		return params.isForum;
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
//#region extensions/telegram/src/network-errors.ts
const TELEGRAM_NETWORK_ORIGIN = Symbol("openclaw.telegram.network-origin");
const RECOVERABLE_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_ABORTED",
	"ECONNABORTED",
	"ERR_NETWORK"
]);
/**
* Error codes that are safe to retry for non-idempotent send operations (e.g. sendMessage).
*
* These represent failures that occur *before* the request reaches Telegram's servers,
* meaning the message was definitely not delivered and it is safe to retry.
*
* Contrast with RECOVERABLE_ERROR_CODES which includes codes like ECONNRESET and ETIMEDOUT
* that can fire *after* Telegram has already received and delivered a message — retrying
* those would cause duplicate messages.
*/
const PRE_CONNECT_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH"
]);
const RECOVERABLE_ERROR_NAMES = new Set([
	"AbortError",
	"TimeoutError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError"
]);
const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE = /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;
const RECOVERABLE_MESSAGE_SNIPPETS = [
	"undici",
	"network error",
	"network request",
	"client network socket disconnected",
	"socket hang up",
	"getaddrinfo",
	"timeout",
	"timed out"
];
function collectTelegramErrorCandidates(err) {
	return collectErrorGraphCandidates(err, (current) => {
		const nested = [current.cause, current.reason];
		if (Array.isArray(current.errors)) nested.push(...current.errors);
		if (readErrorName(current) === "HttpError") nested.push(current.error);
		return nested;
	});
}
function normalizeCode(code) {
	return code?.trim().toUpperCase() ?? "";
}
function getErrorCode(err) {
	const direct = extractErrorCode(err);
	if (direct) return direct;
	if (!err || typeof err !== "object") return;
	const errno = err.errno;
	if (typeof errno === "string") return errno;
	if (typeof errno === "number") return String(errno);
}
function normalizeTelegramNetworkMethod(method) {
	const trimmed = method?.trim();
	if (!trimmed) return null;
	return normalizeLowercaseStringOrEmpty(trimmed);
}
function tagTelegramNetworkError(err, origin) {
	if (!err || typeof err !== "object") return;
	Object.defineProperty(err, TELEGRAM_NETWORK_ORIGIN, {
		value: {
			method: normalizeTelegramNetworkMethod(origin.method),
			url: typeof origin.url === "string" && origin.url.trim() ? origin.url : null
		},
		configurable: true
	});
}
function getTelegramNetworkErrorOrigin(err) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object") continue;
		const origin = candidate[TELEGRAM_NETWORK_ORIGIN];
		if (!origin || typeof origin !== "object") continue;
		return {
			method: "method" in origin && typeof origin.method === "string" ? origin.method : null,
			url: "url" in origin && typeof origin.url === "string" ? origin.url : null
		};
	}
	return null;
}
function isTelegramPollingNetworkError(err) {
	return getTelegramNetworkErrorOrigin(err)?.method === "getupdates";
}
/**
* Returns true if the error is safe to retry for a non-idempotent Telegram send operation
* (e.g. sendMessage). Only matches errors that are guaranteed to have occurred *before*
* the request reached Telegram's servers, preventing duplicate message delivery.
*
* Use this instead of isRecoverableTelegramNetworkError for sendMessage/sendPhoto/etc.
* calls where a retry would create a duplicate visible message.
*/
function isSafeToRetrySendError(err) {
	if (!err) return false;
	for (const candidate of collectTelegramErrorCandidates(err)) {
		const code = normalizeCode(getErrorCode(candidate));
		if (code && PRE_CONNECT_ERROR_CODES.has(code)) return true;
	}
	return false;
}
function hasTelegramErrorCode(err, matches) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) continue;
		const code = candidate.error_code;
		if (typeof code === "number" && matches(code)) return true;
	}
	return false;
}
function hasTelegramRetryAfter(err) {
	for (const candidate of collectTelegramErrorCandidates(err)) {
		if (!candidate || typeof candidate !== "object") continue;
		const retryAfter = "parameters" in candidate && candidate.parameters && typeof candidate.parameters === "object" ? candidate.parameters.retry_after : "response" in candidate && candidate.response && typeof candidate.response === "object" && "parameters" in candidate.response ? candidate.response.parameters?.retry_after : "error" in candidate && candidate.error && typeof candidate.error === "object" && "parameters" in candidate.error ? candidate.error.parameters?.retry_after : void 0;
		if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) return true;
	}
	return false;
}
/** Returns true for HTTP 5xx server errors (error may have been processed). */
function isTelegramServerError(err) {
	return hasTelegramErrorCode(err, (code) => code >= 500);
}
function isTelegramRateLimitError(err) {
	return hasTelegramErrorCode(err, (code) => code === 429) || hasTelegramRetryAfter(err) && /(?:^|\b)429\b|too many requests/i.test(formatErrorMessage(err));
}
/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
function isTelegramClientRejection(err) {
	return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}
function isRecoverableTelegramNetworkError(err, options = {}) {
	if (!err) return false;
	const allowMessageMatch = typeof options.allowMessageMatch === "boolean" ? options.allowMessageMatch : options.context !== "send";
	for (const candidate of collectTelegramErrorCandidates(err)) {
		const code = normalizeCode(getErrorCode(candidate));
		if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;
		const name = readErrorName(candidate);
		if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;
		const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
		if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) return true;
		if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) return true;
		if (allowMessageMatch && message) {
			if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) return true;
		}
	}
	return false;
}
//#endregion
//#region extensions/telegram/src/format.ts
function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
				open: "<pre><code>",
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
function markdownToTelegramHtml(markdown, options = {}) {
	const html = renderTelegramHtml(markdownToIR(markdown ?? "", {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	}));
	if (options.wrapFileRefs !== false) return wrapFileReferencesInHtml(html);
	return html;
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
let fileReferencePattern;
let orphanedTldPattern;
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
	if ((options.textMode ?? "markdown") === "html") return text;
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
	return wrapFileReferencesInHtml(renderTelegramHtml(ir));
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
	return renderTelegramChunksWithinHtmlLimit(markdownToIR(markdown ?? "", {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "none",
		blockquotePrefix: "",
		tableMode: options.tableMode
	}), limit);
}
function markdownToTelegramHtmlChunks(markdown, limit) {
	return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
//#endregion
//#region extensions/telegram/src/api-logging.ts
const fallbackLogger = createSubsystemLogger("telegram/api");
function resolveTelegramApiLogger(runtime, logger) {
	if (logger) return logger;
	if (runtime?.error) return runtime.error;
	return (message) => fallbackLogger.error(message);
}
async function withTelegramApiErrorLogging({ operation, fn, runtime, logger, shouldLog }) {
	try {
		return await fn();
	} catch (err) {
		if (!shouldLog || shouldLog(err)) {
			const errText = formatErrorMessage(err);
			resolveTelegramApiLogger(runtime, logger)(`telegram ${operation} failed: ${errText}`);
		}
		throw err;
	}
}
function splitTelegramCaption(text) {
	const trimmed = text?.trim() ?? "";
	if (!trimmed) return {
		caption: void 0,
		followUpText: void 0
	};
	if (trimmed.length > 1024) return {
		caption: void 0,
		followUpText: trimmed
	};
	return {
		caption: trimmed,
		followUpText: void 0
	};
}
//#endregion
//#region extensions/telegram/src/inline-keyboard.ts
function buildInlineKeyboard(buttons) {
	if (!buttons?.length) return;
	const rows = buttons.map((row) => row.filter((button) => button?.text && button?.callback_data).map((button) => Object.assign({
		text: button.text,
		callback_data: button.callback_data
	}, button.style ? { style: button.style } : {}))).filter((row) => row.length > 0);
	if (rows.length === 0) return;
	return { inline_keyboard: rows };
}
//#endregion
//#region extensions/telegram/src/reply-parameters.ts
function resolveTelegramSendThreadSpec(params) {
	const messageThreadId = params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
	if (messageThreadId == null) return;
	return {
		id: messageThreadId,
		scope: params.chatType === "direct" ? "dm" : "forum"
	};
}
function buildTelegramThreadReplyParams(opts) {
	const params = {};
	const threadParams = buildTelegramThreadParams(opts?.thread);
	if (threadParams) params.message_thread_id = threadParams.message_thread_id;
	const replyToMessageId = normalizeTelegramReplyToMessageId(opts?.replyToMessageId);
	if (replyToMessageId == null) return params;
	const defaultQuoteMessageId = opts?.useReplyIdAsQuoteSource === true ? replyToMessageId : void 0;
	const replyQuoteTextRaw = normalizeTelegramReplyToMessageId(opts?.replyQuoteMessageId ?? defaultQuoteMessageId) === replyToMessageId ? opts?.replyQuoteText : void 0;
	const replyQuoteText = replyQuoteTextRaw?.trim() ? replyQuoteTextRaw : void 0;
	if (!replyQuoteText) {
		params.reply_to_message_id = replyToMessageId;
		params.allow_sending_without_reply = true;
		return params;
	}
	const replyParameters = {
		message_id: replyToMessageId,
		quote: replyQuoteText,
		allow_sending_without_reply: true
	};
	if (typeof opts?.replyQuotePosition === "number" && Number.isFinite(opts.replyQuotePosition)) replyParameters.quote_position = Math.trunc(opts.replyQuotePosition);
	if (Array.isArray(opts?.replyQuoteEntities) && opts.replyQuoteEntities.length > 0) replyParameters.quote_entities = opts.replyQuoteEntities;
	params.reply_parameters = replyParameters;
	return params;
}
function buildTelegramSendParams(opts) {
	const params = { ...buildTelegramThreadReplyParams(opts) };
	if (opts?.silent === true) params.disable_notification = true;
	return params;
}
function getTelegramNativeQuoteReplyMessageId(params) {
	const replyParameters = params?.reply_parameters;
	if (!replyParameters || typeof replyParameters !== "object") return;
	const messageId = replyParameters.message_id;
	return typeof messageId === "number" && Number.isFinite(messageId) ? messageId : void 0;
}
function removeTelegramNativeQuoteParam(params) {
	if (!params) return {};
	const replyMessageId = getTelegramNativeQuoteReplyMessageId(params);
	const { reply_parameters: _ignored, ...rest } = params;
	if (replyMessageId != null) {
		rest.reply_to_message_id = replyMessageId;
		rest.allow_sending_without_reply = true;
	}
	return rest;
}
//#endregion
//#region extensions/telegram/src/sent-message-cache.ts
const TTL_MS = 1440 * 60 * 1e3;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");
function getSentMessageState() {
	const globalStore = globalThis;
	const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY];
	if (existing) return existing;
	const state = { bucketsByPath: /* @__PURE__ */ new Map() };
	globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] = state;
	return state;
}
function createSentMessageStore() {
	return /* @__PURE__ */ new Map();
}
function resolveSentMessageStorePath(cfg) {
	return `${resolveStorePath(cfg?.session?.store)}.telegram-sent-messages.json`;
}
function cleanupExpired(store, scopeKey, entry, now) {
	for (const [id, timestamp] of entry) if (now - timestamp > TTL_MS) entry.delete(id);
	if (entry.size === 0) store.delete(scopeKey);
}
function readPersistedSentMessages(filePath) {
	if (!fs.existsSync(filePath)) return createSentMessageStore();
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		const now = Date.now();
		const store = createSentMessageStore();
		for (const [chatId, entry] of Object.entries(parsed)) {
			const messages = /* @__PURE__ */ new Map();
			for (const [messageId, timestamp] of Object.entries(entry)) if (typeof timestamp === "number" && Number.isFinite(timestamp) && now - timestamp <= TTL_MS) messages.set(messageId, timestamp);
			if (messages.size > 0) store.set(chatId, messages);
		}
		return store;
	} catch (error) {
		logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
		return createSentMessageStore();
	}
}
function getSentMessageBucket(cfg) {
	const state = getSentMessageState();
	const persistedPath = resolveSentMessageStorePath(cfg);
	const existing = state.bucketsByPath.get(persistedPath);
	if (existing) return existing;
	const bucket = {
		persistedPath,
		store: readPersistedSentMessages(persistedPath)
	};
	state.bucketsByPath.set(persistedPath, bucket);
	return bucket;
}
function getSentMessages(cfg) {
	return getSentMessageBucket(cfg).store;
}
function persistSentMessages(bucket) {
	const { store, persistedPath } = bucket;
	const now = Date.now();
	const serialized = {};
	for (const [chatId, entry] of store) {
		cleanupExpired(store, chatId, entry, now);
		if (entry.size > 0) serialized[chatId] = Object.fromEntries(entry);
	}
	if (Object.keys(serialized).length === 0) {
		fs.rmSync(persistedPath, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
	const tempPath = `${persistedPath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(serialized), "utf-8");
	fs.renameSync(tempPath, persistedPath);
}
function recordSentMessage(chatId, messageId, cfg) {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const now = Date.now();
	const bucket = getSentMessageBucket(cfg);
	const { store } = bucket;
	let entry = store.get(scopeKey);
	if (!entry) {
		entry = /* @__PURE__ */ new Map();
		store.set(scopeKey, entry);
	}
	entry.set(idKey, now);
	if (entry.size > 100) cleanupExpired(store, scopeKey, entry, now);
	try {
		persistSentMessages(bucket);
	} catch (error) {
		logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
	}
}
function wasSentByBot(chatId, messageId, cfg) {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const store = getSentMessages(cfg);
	const entry = store.get(scopeKey);
	if (!entry) return false;
	cleanupExpired(store, scopeKey, entry, Date.now());
	return entry.has(idKey);
}
//#endregion
//#region extensions/telegram/src/target-writeback.ts
const writebackLogger = createSubsystemLogger("telegram/target-writeback");
const TELEGRAM_ADMIN_SCOPE = "operator.admin";
function asObjectRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeTelegramLookupTargetForMatch(raw) {
	const normalized = normalizeTelegramLookupTarget(raw);
	if (!normalized) return;
	return normalized.startsWith("@") ? normalizeLowercaseStringOrEmpty(normalized) : normalized;
}
function normalizeTelegramTargetForMatch(raw) {
	const parsed = parseTelegramTarget(raw);
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return;
	return `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`;
}
function buildResolvedTelegramTarget(params) {
	const { raw, parsed, resolvedChatId } = params;
	if (parsed.messageThreadId == null) return resolvedChatId;
	return raw.includes(":topic:") ? `${resolvedChatId}:topic:${parsed.messageThreadId}` : `${resolvedChatId}:${parsed.messageThreadId}`;
}
function resolveLegacyRewrite(params) {
	const parsed = parseTelegramTarget(params.raw);
	if (normalizeTelegramChatId(parsed.chatId)) return null;
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return null;
	return {
		matchKey: `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`,
		resolvedTarget: buildResolvedTelegramTarget({
			raw: params.raw,
			parsed,
			resolvedChatId: params.resolvedChatId
		})
	};
}
function rewriteTargetIfMatch(params) {
	if (typeof params.rawValue !== "string" && typeof params.rawValue !== "number") return null;
	const value = normalizeOptionalString(String(params.rawValue)) ?? "";
	if (!value) return null;
	if (normalizeTelegramTargetForMatch(value) !== params.matchKey) return null;
	return params.resolvedTarget;
}
function replaceTelegramDefaultToTargets(params) {
	let changed = false;
	const telegram = asObjectRecord(params.cfg.channels?.telegram);
	if (!telegram) return changed;
	const maybeReplace = (holder, key) => {
		const nextTarget = rewriteTargetIfMatch({
			rawValue: holder[key],
			matchKey: params.matchKey,
			resolvedTarget: params.resolvedTarget
		});
		if (!nextTarget) return;
		holder[key] = nextTarget;
		changed = true;
	};
	maybeReplace(telegram, "defaultTo");
	const accounts = asObjectRecord(telegram.accounts);
	if (!accounts) return changed;
	for (const accountId of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[accountId]);
		if (!account) continue;
		maybeReplace(account, "defaultTo");
	}
	return changed;
}
async function maybePersistResolvedTelegramTarget(params) {
	const raw = params.rawTarget.trim();
	if (!raw) return;
	const rewrite = resolveLegacyRewrite({
		raw,
		resolvedChatId: params.resolvedChatId
	});
	if (!rewrite) return;
	const { matchKey, resolvedTarget } = rewrite;
	if (Array.isArray(params.gatewayClientScopes) && !params.gatewayClientScopes.includes(TELEGRAM_ADMIN_SCOPE)) {
		writebackLogger.warn(`skipping Telegram target writeback for ${raw} because gateway caller is missing ${TELEGRAM_ADMIN_SCOPE}`);
		return;
	}
	try {
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		const nextConfig = structuredClone(snapshot.config ?? {});
		if (replaceTelegramDefaultToTargets({
			cfg: nextConfig,
			matchKey,
			resolvedTarget
		})) {
			await replaceConfigFile({
				nextConfig,
				snapshot,
				writeOptions,
				afterWrite: { mode: "auto" }
			});
			if (params.verbose) writebackLogger.warn(`resolved Telegram defaultTo target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram defaultTo target ${raw}: ${String(err)}`);
	}
	try {
		const storePath = resolveCronStorePath(params.cfg.cron?.store);
		const store = await loadCronStore(storePath);
		let cronChanged = false;
		for (const job of store.jobs) {
			if (job.delivery?.channel !== "telegram") continue;
			const nextTarget = rewriteTargetIfMatch({
				rawValue: job.delivery.to,
				matchKey,
				resolvedTarget
			});
			if (!nextTarget) continue;
			job.delivery.to = nextTarget;
			cronChanged = true;
		}
		if (cronChanged) {
			await saveCronStore(storePath, store);
			if (params.verbose) writebackLogger.warn(`resolved Telegram cron delivery target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram cron target ${raw}: ${String(err)}`);
	}
}
//#endregion
//#region extensions/telegram/src/voice.ts
function resolveTelegramVoiceDecision(opts) {
	if (!opts.wantsVoice) return { useVoice: false };
	if (isVoiceCompatibleAudio(opts)) return { useVoice: true };
	return {
		useVoice: false,
		reason: `media is ${opts.contentType ?? "unknown"} (${opts.fileName ?? "unknown"})`
	};
}
function resolveTelegramVoiceSend(opts) {
	const decision = resolveTelegramVoiceDecision(opts);
	if (decision.reason && opts.logFallback) opts.logFallback(`Telegram voice requested but ${decision.reason}; sending as audio file instead.`);
	return { useVoice: decision.useVoice };
}
//#endregion
//#region extensions/telegram/src/send.ts
const InputFileCtor = grammy.InputFile;
const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 1e4;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;
function resolveTelegramMessageIdOrThrow(result, context) {
	if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) return Math.trunc(result.message_id);
	throw new Error(`Telegram ${context} returned no message_id`);
}
function splitTelegramPlainTextChunks(text, limit) {
	if (!text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const chunks = [];
	for (let start = 0; start < text.length; start += normalizedLimit) chunks.push(text.slice(start, start + normalizedLimit));
	return chunks;
}
function splitTelegramPlainTextFallback(text, chunkCount, limit) {
	if (!text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const fixedChunks = splitTelegramPlainTextChunks(text, normalizedLimit);
	if (chunkCount <= 1 || fixedChunks.length >= chunkCount) return fixedChunks;
	const chunks = [];
	let offset = 0;
	for (let index = 0; index < chunkCount; index += 1) {
		const remainingChars = text.length - offset;
		const remainingChunks = chunkCount - index;
		const nextChunkLength = remainingChunks === 1 ? remainingChars : Math.min(normalizedLimit, Math.ceil(remainingChars / remainingChunks));
		chunks.push(text.slice(offset, offset + nextChunkLength));
		offset += nextChunkLength;
	}
	return chunks;
}
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_DELETE_NOOP_RE = /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
const telegramClientOptionsCache = /* @__PURE__ */ new Map();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;
function asTelegramClientFetch(fetchImpl) {
	return fetchImpl;
}
function resetTelegramClientOptionsCacheForTests() {
	telegramClientOptionsCache.clear();
}
function createTelegramHttpLogger(cfg) {
	if (!isDiagnosticFlagEnabled("telegram.http", cfg)) return () => {};
	return (label, err) => {
		if (!(err instanceof HttpError)) return;
		const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
		diagLogger.warn(`telegram http error (${label}): ${detail}`);
	};
}
function shouldUseTelegramClientOptionsCache() {
	return !process.env.VITEST && true;
}
function buildTelegramClientOptionsCacheKey(params) {
	const proxyKey = params.account.config.proxy?.trim() ?? "";
	const autoSelectFamily = params.account.config.network?.autoSelectFamily;
	const autoSelectFamilyKey = typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
	const dnsResultOrderKey = params.account.config.network?.dnsResultOrder ?? "default";
	const apiRootKey = params.account.config.apiRoot?.trim() ?? "";
	const timeoutSecondsKey = typeof params.timeoutSeconds === "number" ? String(params.timeoutSeconds) : "default";
	return `${params.account.accountId}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}::${timeoutSecondsKey}`;
}
function setCachedTelegramClientOptions(cacheKey, clientOptions) {
	telegramClientOptionsCache.set(cacheKey, clientOptions);
	if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
		const oldestKey = telegramClientOptionsCache.keys().next().value;
		if (oldestKey !== void 0) telegramClientOptionsCache.delete(oldestKey);
	}
	return clientOptions;
}
function resolveTelegramClientOptions(account) {
	const timeoutSeconds = typeof account.config.timeoutSeconds === "number" && Number.isFinite(account.config.timeoutSeconds) ? Math.max(1, Math.floor(account.config.timeoutSeconds)) : void 0;
	const cacheKey = shouldUseTelegramClientOptionsCache() ? buildTelegramClientOptionsCacheKey({
		account,
		timeoutSeconds
	}) : null;
	if (cacheKey && telegramClientOptionsCache.has(cacheKey)) return telegramClientOptionsCache.get(cacheKey);
	const proxyUrl = normalizeOptionalString(account.config.proxy);
	const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : void 0;
	const apiRoot = normalizeOptionalString(account.config.apiRoot);
	const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : void 0;
	const fetchImpl = resolveTelegramFetch(proxyFetch, { network: account.config.network });
	const clientOptions = fetchImpl || timeoutSeconds || normalizedApiRoot ? {
		...fetchImpl ? { fetch: asTelegramClientFetch(fetchImpl) } : {},
		...timeoutSeconds ? { timeoutSeconds } : {},
		...normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}
	} : void 0;
	if (cacheKey) return setCachedTelegramClientOptions(cacheKey, clientOptions);
	return clientOptions;
}
function resolveToken(explicit, params) {
	if (explicit?.trim()) return explicit.trim();
	if (!params.token) throw new Error(`Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
	return params.token.trim();
}
async function resolveChatId(to, params) {
	const numericChatId = normalizeTelegramChatId(to);
	if (numericChatId) return numericChatId;
	const lookupTarget = normalizeTelegramLookupTarget(to);
	const getChat = params.api.getChat;
	if (!lookupTarget || typeof getChat !== "function") throw new Error("Telegram recipient must be a numeric chat ID");
	try {
		const chat = await getChat.call(params.api, lookupTarget);
		const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
		if (!resolved) throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
		if (params.verbose) sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
		return resolved;
	} catch (err) {
		const detail = formatErrorMessage(err);
		throw new Error(`Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`, { cause: err });
	}
}
async function resolveAndPersistChatId(params) {
	const chatId = await resolveChatId(params.lookupTarget, {
		api: params.api,
		verbose: params.verbose
	});
	await maybePersistResolvedTelegramTarget({
		cfg: params.cfg,
		rawTarget: params.persistTarget,
		resolvedChatId: chatId,
		verbose: params.verbose,
		gatewayClientScopes: params.gatewayClientScopes
	});
	return chatId;
}
function normalizeMessageId(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
	if (typeof raw === "string") {
		const value = raw.trim();
		if (!value) throw new Error("Message id is required for Telegram actions");
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new Error("Message id is required for Telegram actions");
}
function isTelegramThreadNotFoundError(err) {
	return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}
function isTelegramMessageNotModifiedError(err) {
	return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}
function isTelegramMessageDeleteNoopError(err) {
	return MESSAGE_DELETE_NOOP_RE.test(formatErrorMessage(err));
}
function hasMessageThreadIdParam(params) {
	if (!params) return false;
	const value = params.message_thread_id;
	if (typeof value === "number") return Number.isFinite(value);
	return false;
}
function removeMessageThreadIdParam(params) {
	if (!params || !hasMessageThreadIdParam(params)) return params;
	const next = { ...params };
	delete next.message_thread_id;
	return Object.keys(next).length > 0 ? next : void 0;
}
function isTelegramHtmlParseError(err) {
	return PARSE_ERR_RE.test(formatErrorMessage(err));
}
async function withTelegramHtmlParseFallback(params) {
	try {
		return await params.requestHtml(params.label);
	} catch (err) {
		if (!isTelegramHtmlParseError(err)) throw err;
		if (params.verbose) sendLogger.warn(`telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(err)}`);
		return await params.requestPlain(`${params.label}-plain`);
	}
}
function resolveTelegramApiContext(opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Telegram API context");
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken(opts.token, account);
	const client = resolveTelegramClientOptions(account);
	return {
		cfg,
		account,
		api: opts.api ?? new Bot(token, client ? { client } : void 0).api
	};
}
function createTelegramRequestWithDiag(params) {
	const request = createChannelApiRetryRunner({
		retry: params.retry,
		configRetry: params.account.config.retry,
		verbose: params.verbose,
		...params.shouldRetry ? { shouldRetry: params.shouldRetry } : {},
		...params.strictShouldRetry ? { strictShouldRetry: true } : {}
	});
	const logHttpError = createTelegramHttpLogger(params.cfg);
	return (fn, label, options) => {
		const runRequest = () => request(fn, label);
		return (params.useApiErrorLogging === false ? runRequest() : withTelegramApiErrorLogging({
			operation: label ?? "request",
			fn: runRequest,
			...options?.shouldLog ? { shouldLog: options.shouldLog } : {}
		})).catch((err) => {
			logHttpError(label ?? "request", err);
			throw err;
		});
	};
}
function wrapTelegramChatNotFoundError(err, params) {
	const errorMsg = formatErrorMessage(err);
	if (/403.*(bot.*not.*member|bot.*blocked|bot.*kicked)/i.test(errorMsg)) return new Error([
		`Telegram send failed: bot is not a member of the chat, was blocked, or was kicked (chat_id=${params.chatId}).`,
		`Telegram API said: ${errorMsg}.`,
		"Fix: Add the bot to the channel/group, or ensure it has not been removed/blocked/kicked by the user.",
		`Input was: ${JSON.stringify(params.input)}.`
	].join(" "));
	if (!CHAT_NOT_FOUND_RE.test(errorMsg)) return err;
	return new Error([
		`Telegram send failed: chat not found (chat_id=${params.chatId}).`,
		"Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
		`Input was: ${JSON.stringify(params.input)}.`
	].join(" "));
}
async function withTelegramThreadFallback(params, label, verbose, attempt) {
	try {
		return await attempt(params, label);
	} catch (err) {
		if (!hasMessageThreadIdParam(params) || !isTelegramThreadNotFoundError(err)) throw err;
		if (verbose) sendLogger.warn(`telegram ${label} failed with message_thread_id, retrying without thread: ${formatErrorMessage(err)}`);
		return await attempt(removeMessageThreadIdParam(params), `${label}-threadless`);
	}
}
function createRequestWithChatNotFound(params) {
	return async (fn, label) => params.requestWithDiag(fn, label).catch((err) => {
		throw wrapTelegramChatNotFoundError(err, {
			chatId: params.chatId,
			input: params.input
		});
	});
}
function createTelegramNonIdempotentRequestWithDiag(params) {
	return createTelegramRequestWithDiag({
		cfg: params.cfg,
		account: params.account,
		retry: params.retry,
		verbose: params.verbose,
		useApiErrorLogging: params.useApiErrorLogging,
		shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
		strictShouldRetry: true
	});
}
async function sendMessageTelegram(to, text, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const mediaUrl = opts.mediaUrl?.trim();
	const mediaMaxBytes = opts.maxBytes ?? (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) * 1024 * 1024;
	const replyMarkup = buildInlineKeyboard(opts.buttons);
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId,
		replyQuoteText: opts.quoteText,
		useReplyIdAsQuoteSource: true
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose
		}),
		chatId,
		input: to
	});
	const textMode = opts.textMode ?? "markdown";
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: account.accountId
	});
	const renderHtmlText = (value) => renderTelegramHtmlText(value, {
		textMode,
		tableMode
	});
	const linkPreviewOptions = account.config.linkPreview ?? true ? void 0 : { is_disabled: true };
	const sendTelegramTextChunk = async (chunk, params) => {
		return await withTelegramThreadFallback(params, "message", opts.verbose, async (effectiveParams, label) => {
			const baseParams = effectiveParams ? { ...effectiveParams } : {};
			if (linkPreviewOptions) baseParams.link_preview_options = linkPreviewOptions;
			const plainParams = {
				...baseParams,
				...opts.silent === true ? { disable_notification: true } : {}
			};
			const hasPlainParams = Object.keys(plainParams).length > 0;
			const requestPlain = (retryLabel) => requestWithChatNotFound(() => hasPlainParams ? api.sendMessage(chatId, chunk.plainText, plainParams) : api.sendMessage(chatId, chunk.plainText), retryLabel);
			if (!chunk.htmlText) return await requestPlain(label);
			const htmlText = chunk.htmlText;
			const htmlParams = {
				parse_mode: "HTML",
				...plainParams
			};
			return await withTelegramHtmlParseFallback({
				label,
				verbose: opts.verbose,
				requestHtml: (retryLabel) => requestWithChatNotFound(() => api.sendMessage(chatId, htmlText, htmlParams), retryLabel),
				requestPlain
			});
		});
	};
	const buildTextParams = (isLastChunk) => hasThreadParams || isLastChunk && replyMarkup ? {
		...threadParams,
		...isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}
	} : void 0;
	const sendTelegramTextChunks = async (chunks, context) => {
		let lastMessageId = "";
		let lastChatId = chatId;
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index];
			if (!chunk) continue;
			const res = await sendTelegramTextChunk(chunk, buildTextParams(index === chunks.length - 1));
			const messageId = resolveTelegramMessageIdOrThrow(res, context);
			recordSentMessage(chatId, messageId, cfg);
			lastMessageId = String(messageId);
			lastChatId = String(res?.chat?.id ?? chatId);
		}
		return {
			messageId: lastMessageId,
			chatId: lastChatId
		};
	};
	const buildChunkedTextPlan = (rawText, context) => {
		const htmlText = renderHtmlText(rawText);
		const fallbackText = opts.plainText ?? rawText;
		let htmlChunks;
		try {
			htmlChunks = splitTelegramHtmlChunks(htmlText, 4e3);
		} catch (error) {
			logVerbose(`telegram ${context} failed HTML chunk planning, retrying as plain text: ${formatErrorMessage(error)}`);
			return splitTelegramPlainTextChunks(fallbackText, 4e3).map((plainText) => ({ plainText }));
		}
		const fixedPlainTextChunks = splitTelegramPlainTextChunks(fallbackText, 4e3);
		if (fixedPlainTextChunks.length > htmlChunks.length) {
			logVerbose(`telegram ${context} plain-text fallback needs more chunks than HTML; sending plain text`);
			return fixedPlainTextChunks.map((plainText) => ({ plainText }));
		}
		const plainTextChunks = splitTelegramPlainTextFallback(fallbackText, htmlChunks.length, 4e3);
		return htmlChunks.map((htmlText, index) => ({
			htmlText,
			plainText: plainTextChunks[index] ?? htmlText
		}));
	};
	const sendChunkedText = async (rawText, context) => await sendTelegramTextChunks(buildChunkedTextPlan(rawText, context), context);
	async function shouldSendTelegramImageAsPhoto(buffer) {
		try {
			const metadata = await getImageMetadata(buffer);
			const width = metadata?.width;
			const height = metadata?.height;
			if (typeof width !== "number" || typeof height !== "number") {
				sendLogger.warn("Photo dimensions are unavailable. Sending as document instead.");
				return false;
			}
			const shorterSide = Math.min(width, height);
			const longerSide = Math.max(width, height);
			if (!(width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM && shorterSide > 0 && longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO)) {
				sendLogger.warn(`Photo dimensions (${width}x${height}) are not valid for Telegram photos. Sending as document instead.`);
				return false;
			}
			return true;
		} catch (err) {
			sendLogger.warn(`Failed to validate photo dimensions: ${formatErrorMessage(err)}. Sending as document instead.`);
			return false;
		}
	}
	if (mediaUrl) {
		const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
			maxBytes: mediaMaxBytes,
			mediaLocalRoots: opts.mediaLocalRoots,
			mediaReadFile: opts.mediaReadFile,
			optimizeImages: opts.forceDocument ? false : void 0
		}));
		const kind = kindFromMime(media.contentType ?? void 0);
		const isGif = isGifMedia({
			contentType: media.contentType,
			fileName: media.fileName
		});
		let sendImageAsPhoto = true;
		if (kind === "image" && !isGif && !opts.forceDocument) sendImageAsPhoto = await shouldSendTelegramImageAsPhoto(media.buffer);
		const isVideoNote = kind === "video" && opts.asVideoNote === true;
		const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind ?? "document")) ?? "file";
		const file = new InputFileCtor(media.buffer, fileName);
		let caption;
		let followUpText;
		if (isVideoNote) {
			caption = void 0;
			followUpText = text.trim() ? text : void 0;
		} else {
			const split = splitTelegramCaption(text);
			caption = split.caption;
			followUpText = split.followUpText;
		}
		const htmlCaption = caption ? renderHtmlText(caption) : void 0;
		const needsSeparateText = Boolean(followUpText);
		const baseMediaParams = {
			...hasThreadParams ? threadParams : {},
			...!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}
		};
		const videoDimensions = kind === "video" && !isVideoNote ? await probeVideoDimensions(media.buffer) : void 0;
		const mediaParams = {
			...htmlCaption ? {
				caption: htmlCaption,
				parse_mode: "HTML"
			} : {},
			...baseMediaParams,
			...opts.silent === true ? { disable_notification: true } : {},
			...videoDimensions ? {
				width: videoDimensions.width,
				height: videoDimensions.height
			} : {}
		};
		const sendMedia = async (label, sender) => await withTelegramThreadFallback(mediaParams, label, opts.verbose, async (effectiveParams, retryLabel) => requestWithChatNotFound(() => sender(effectiveParams), retryLabel));
		const mediaSender = (() => {
			if (isGif && !opts.forceDocument) return {
				label: "animation",
				sender: (effectiveParams) => api.sendAnimation(chatId, file, effectiveParams)
			};
			if (kind === "image" && !opts.forceDocument && sendImageAsPhoto) return {
				label: "photo",
				sender: (effectiveParams) => api.sendPhoto(chatId, file, effectiveParams)
			};
			if (kind === "video") {
				if (isVideoNote) return {
					label: "video_note",
					sender: (effectiveParams) => api.sendVideoNote(chatId, file, effectiveParams)
				};
				return {
					label: "video",
					sender: (effectiveParams) => api.sendVideo(chatId, file, effectiveParams)
				};
			}
			if (kind === "audio") {
				const { useVoice } = resolveTelegramVoiceSend({
					wantsVoice: opts.asVoice === true,
					contentType: media.contentType,
					fileName,
					logFallback: logVerbose
				});
				if (useVoice) return {
					label: "voice",
					sender: (effectiveParams) => api.sendVoice(chatId, file, effectiveParams)
				};
				return {
					label: "audio",
					sender: (effectiveParams) => api.sendAudio(chatId, file, effectiveParams)
				};
			}
			return {
				label: "document",
				sender: (effectiveParams) => api.sendDocument(chatId, file, opts.forceDocument ? {
					...effectiveParams,
					disable_content_type_detection: true
				} : effectiveParams)
			};
		})();
		const result = await sendMedia(mediaSender.label, mediaSender.sender);
		const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
		const resolvedChatId = String(result?.chat?.id ?? chatId);
		recordSentMessage(chatId, mediaMessageId, cfg);
		recordChannelActivity({
			channel: "telegram",
			accountId: account.accountId,
			direction: "outbound"
		});
		if (needsSeparateText && followUpText) return {
			messageId: (await sendChunkedText(followUpText, "text follow-up send")).messageId,
			chatId: resolvedChatId
		};
		return {
			messageId: String(mediaMessageId),
			chatId: resolvedChatId
		};
	}
	if (!text || !text.trim()) throw new Error("Message must be non-empty for Telegram sends");
	const textResult = await sendChunkedText(text, "text send");
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return textResult;
}
async function sendTypingTelegram(to, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const threadParams = buildTypingThreadParams(target.messageThreadId ?? opts.messageThreadId);
	await requestWithDiag(() => api.sendChatAction(chatId, "typing", threadParams), "typing");
	return { ok: true };
}
async function reactMessageTelegram(chatIdInput, messageIdInput, emoji, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const remove = opts.remove === true;
	const trimmedEmoji = emoji.trim();
	const reactions = remove || !trimmedEmoji ? [] : [{
		type: "emoji",
		emoji: trimmedEmoji
	}];
	if (typeof api.setMessageReaction !== "function") throw new Error("Telegram reactions are unavailable in this bot API.");
	try {
		await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
	} catch (err) {
		const msg = formatErrorMessage(err);
		if (/REACTION_INVALID/i.test(msg)) return {
			ok: false,
			warning: `Reaction unavailable: ${trimmedEmoji}`
		};
		throw err;
	}
	return { ok: true };
}
async function deleteMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	try {
		await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage", { shouldLog: (err) => !isTelegramMessageDeleteNoopError(err) });
	} catch (err) {
		if (!isTelegramMessageDeleteNoopError(err)) throw err;
		const detail = formatErrorMessage(err);
		logVerbose(`[telegram] Delete skipped for message ${messageId} in chat ${chatId}: ${detail}`);
		return {
			ok: false,
			warning: `Message ${messageId} was not deleted: ${detail}`
		};
	}
	logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
	return { ok: true };
}
async function pinMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	await createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	})(() => api.pinChatMessage(chatId, messageId, { disable_notification: opts.notify !== true }), "pinChatMessage");
	logVerbose(`[telegram] Pinned message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
async function unpinMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = messageIdInput === void 0 ? void 0 : normalizeMessageId(messageIdInput);
	await createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	})(() => api.unpinChatMessage(chatId, messageId), "unpinChatMessage");
	logVerbose(`[telegram] Unpinned ${messageId != null ? `message ${messageId}` : "active message"} in chat ${chatId}`);
	return {
		ok: true,
		chatId,
		...messageId != null ? { messageId: String(messageId) } : {}
	};
}
async function editForumTopicTelegram(chatIdInput, messageThreadIdInput, opts) {
	const nameProvided = opts.name !== void 0;
	const trimmedName = opts.name?.trim();
	if (nameProvided && !trimmedName) throw new Error("Telegram forum topic name is required");
	if (trimmedName && trimmedName.length > 128) throw new Error("Telegram forum topic name must be 128 characters or fewer");
	const iconProvided = opts.iconCustomEmojiId !== void 0;
	const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
	if (iconProvided && !trimmedIconCustomEmojiId) throw new Error("Telegram forum topic icon custom emoji ID is required");
	if (!trimmedName && !trimmedIconCustomEmojiId) throw new Error("Telegram forum topic update requires a name or iconCustomEmojiId");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: parseTelegramTarget(rawTarget).chatId,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageThreadId = normalizeMessageId(messageThreadIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const payload = {
		...trimmedName ? { name: trimmedName } : {},
		...trimmedIconCustomEmojiId ? { icon_custom_emoji_id: trimmedIconCustomEmojiId } : {}
	};
	await requestWithDiag(() => api.editForumTopic(chatId, messageThreadId, payload), "editForumTopic");
	logVerbose(`[telegram] Edited forum topic ${messageThreadId} in chat ${chatId}`);
	return {
		ok: true,
		chatId,
		messageThreadId,
		...trimmedName ? { name: trimmedName } : {},
		...trimmedIconCustomEmojiId ? { iconCustomEmojiId: trimmedIconCustomEmojiId } : {}
	};
}
async function renameForumTopicTelegram(chatIdInput, messageThreadIdInput, name, opts) {
	const result = await editForumTopicTelegram(chatIdInput, messageThreadIdInput, {
		...opts,
		name
	});
	return {
		ok: true,
		chatId: result.chatId,
		messageThreadId: result.messageThreadId,
		name: result.name ?? name.trim()
	};
}
async function editMessageReplyMarkupTelegram(chatIdInput, messageIdInput, buttons, opts) {
	const { cfg, account, api } = resolveTelegramApiContext({
		...opts,
		cfg: opts.cfg
	});
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const replyMarkup = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
	try {
		await requestWithDiag(() => api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup }), "editMessageReplyMarkup", { shouldLog: (err) => !isTelegramMessageNotModifiedError(err) });
	} catch (err) {
		if (!isTelegramMessageNotModifiedError(err)) throw err;
	}
	logVerbose(`[telegram] Edited reply markup for message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
async function editMessageTelegram(chatIdInput, messageIdInput, text, opts) {
	const { cfg, account, api } = resolveTelegramApiContext({
		...opts,
		cfg: opts.cfg
	});
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { allowMessageMatch: true }) || isTelegramServerError(err)
	});
	const requestWithEditShouldLog = (fn, label, shouldLog) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : void 0);
	const htmlText = renderTelegramHtmlText(text, {
		textMode: opts.textMode ?? "markdown",
		tableMode: resolveMarkdownTableMode({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		})
	});
	const shouldTouchButtons = opts.buttons !== void 0;
	const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : void 0;
	const replyMarkup = shouldTouchButtons ? builtKeyboard ?? { inline_keyboard: [] } : void 0;
	const editParams = { parse_mode: "HTML" };
	if (opts.linkPreview === false) editParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) editParams.reply_markup = replyMarkup;
	const plainParams = {};
	if (opts.linkPreview === false) plainParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) plainParams.reply_markup = replyMarkup;
	try {
		await withTelegramHtmlParseFallback({
			label: "editMessage",
			verbose: opts.verbose,
			requestHtml: (retryLabel) => requestWithEditShouldLog(() => api.editMessageText(chatId, messageId, htmlText, editParams), retryLabel, (err) => !isTelegramMessageNotModifiedError(err)),
			requestPlain: (retryLabel) => requestWithEditShouldLog(() => Object.keys(plainParams).length > 0 ? api.editMessageText(chatId, messageId, text, plainParams) : api.editMessageText(chatId, messageId, text), retryLabel, (plainErr) => !isTelegramMessageNotModifiedError(plainErr))
		});
	} catch (err) {
		if (isTelegramMessageNotModifiedError(err)) {} else throw err;
	}
	logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
function inferFilename(kind) {
	switch (kind) {
		case "image": return "image.jpg";
		case "video": return "video.mp4";
		case "audio": return "audio.ogg";
		default: return "file.bin";
	}
}
/**
* Send a sticker to a Telegram chat by file_id.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param fileId - Telegram file_id of the sticker to send
* @param opts - Optional configuration
*/
async function sendStickerTelegram(to, fileId, opts) {
	if (!fileId?.trim()) throw new Error("Telegram sticker file_id is required");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose,
			useApiErrorLogging: false
		}),
		chatId,
		input: to
	});
	const result = await withTelegramThreadFallback(hasThreadParams ? threadParams : void 0, "sticker", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), effectiveParams), label));
	const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	recordSentMessage(chatId, messageId, opts.cfg);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId
	};
}
/**
* Send a poll to a Telegram chat.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param poll - Poll input with question, options, maxSelections, and optional durationHours
* @param opts - Optional configuration
*/
async function sendPollTelegram(to, poll, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const normalizedPoll = normalizePollInput(poll, { maxOptions: 10 });
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId
	});
	const pollOptions = normalizedPoll.options;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose
		}),
		chatId,
		input: to
	});
	const durationSeconds = normalizedPoll.durationSeconds;
	if (durationSeconds === void 0 && normalizedPoll.durationHours !== void 0) throw new Error("Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.");
	if (durationSeconds !== void 0 && (durationSeconds < 5 || durationSeconds > 600)) throw new Error("Telegram poll durationSeconds must be between 5 and 600");
	const result = await withTelegramThreadFallback({
		allows_multiple_answers: normalizedPoll.maxSelections > 1,
		is_anonymous: opts.isAnonymous ?? true,
		...durationSeconds !== void 0 ? { open_period: durationSeconds } : {},
		...Object.keys(threadParams).length > 0 ? threadParams : {},
		...opts.silent === true ? { disable_notification: true } : {}
	}, "poll", opts.verbose, async (effectiveParams, label) => requestWithChatNotFound(() => api.sendPoll(chatId, normalizedPoll.question, pollOptions, effectiveParams), label));
	const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	const pollId = result?.poll?.id;
	recordSentMessage(chatId, messageId, opts.cfg);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId,
		pollId
	};
}
/**
* Create a forum topic in a Telegram supergroup.
* Requires the bot to have `can_manage_topics` permission.
*
* @param chatId - Supergroup chat ID
* @param name - Topic name (1-128 characters)
* @param opts - Optional configuration
*/
async function createForumTopicTelegram(chatId, name, opts) {
	if (!name?.trim()) throw new Error("Forum topic name is required");
	const trimmedName = name.trim();
	if (trimmedName.length > 128) throw new Error("Forum topic name must be 128 characters or fewer");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const normalizedChatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: parseTelegramTarget(chatId).chatId,
		persistTarget: chatId,
		verbose: opts.verbose
	});
	const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const extra = {};
	if (opts.iconColor != null) extra.icon_color = opts.iconColor;
	if (opts.iconCustomEmojiId?.trim()) extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
	const hasExtra = Object.keys(extra).length > 0;
	const result = await requestWithDiag(() => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : void 0), "createForumTopic");
	const topicId = result.message_thread_id;
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		topicId,
		name: result.name ?? trimmedName,
		chatId: normalizedChatId
	};
}
//#endregion
export { shouldUseTelegramDmThreadSession as $, isSafeToRetrySendError as A, buildTelegramRoutingTarget as B, withTelegramApiErrorLogging as C, resolveTelegramTargetChatType as Ct, renderTelegramHtmlText as D, markdownToTelegramHtmlChunks as E, tagTelegramNetworkError as F, resetTelegramForumFlagCacheForTest as G, buildTypingThreadParams as H, buildGroupLabel as I, resolveTelegramForumThreadId as J, resolveTelegramDirectPeerId as K, buildTelegramGroupFrom as L, isTelegramPollingNetworkError as M, isTelegramRateLimitError as N, wrapFileReferencesInHtml as O, isTelegramServerError as P, resolveTelegramThreadSpec as Q, buildTelegramGroupPeerId as R, splitTelegramCaption as S, parseTelegramTarget as St, markdownToTelegramHtml as T, describeReplyTarget as U, buildTelegramThreadParams as V, extractTelegramForumFlag as W, resolveTelegramReplyId as X, resolveTelegramGroupAllowFromContext as Y, resolveTelegramStreamMode as Z, wasSentByBot as _, parseTelegramReplyToMessageId as _t, editMessageTelegram as a, getTelegramTextParts as at, removeTelegramNativeQuoteParam as b, normalizeTelegramChatId as bt, renameForumTopicTelegram as c, normalizeForwardedContext as ct, sendPollTelegram as d, expandTelegramAllowFromWithAccessGroups as dt, withResolvedTelegramForumFlag as et, sendStickerTelegram as f, isSenderAllowed as ft, recordSentMessage as g, normalizeTelegramReplyToMessageId as gt, resolveTelegramVoiceSend as h, resolveSenderAllowMatch as ht, editMessageReplyMarkupTelegram as i, extractTelegramLocation as it, isTelegramClientRejection as j, isRecoverableTelegramNetworkError as k, resetTelegramClientOptionsCacheForTests as l, resolveTelegramMediaPlaceholder as lt, unpinMessageTelegram as m, normalizeDmAllowFromWithStore as mt, deleteMessageTelegram as n, buildSenderName as nt, pinMessageTelegram as o, hasBotMention as ot, sendTypingTelegram as p, normalizeAllowFrom as pt, resolveTelegramForumFlag as q, editForumTopicTelegram as r, expandTextLinks as rt, reactMessageTelegram as s, isBinaryContent as st, createForumTopicTelegram as t, buildSenderLabel as tt, sendMessageTelegram as u, resolveTelegramPrimaryMedia as ut, buildTelegramSendParams as v, parseTelegramThreadId as vt, markdownToTelegramChunks as w, stripTelegramInternalPrefixes as wt, buildInlineKeyboard as x, normalizeTelegramLookupTarget as xt, getTelegramNativeQuoteReplyMessageId as y, isNumericTelegramChatId as yt, buildTelegramParentPeer as z };
