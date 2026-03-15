import { c as normalizeSecretInputString, s as normalizeResolvedSecretInputString } from "./types.secrets-apkw3WZr.js";
import { Ar as stripMarkdown, At as resolveDmGroupAccessWithLists, Bo as evictOldHistoryKeys, Cp as mapAllowFromEntries, Dt as DM_GROUP_ACCESS_REASON, Fo as logAckFailure, Io as logInboundDrop, Lo as logTypingFailure, Mo as createReplyPrefixOptions, Na as resolveChannelMediaMaxBytes, No as resolveAckReaction, Ns as parseFiniteNumber, Ot as readStoreAllowFromForDmPolicy, Vo as recordPendingHistoryEntryIfEnabled, Wt as resolveControlCommandGate, Ya as readWebhookBodyOrReject, ao as createScopedPairingAccess, hu as resolveRequestUrl, qa as createWebhookInFlightLimiter, ro as issuePairingChallenge } from "./auth-profiles-CuJtivJK.js";
import { a as resolveWebhookTargetWithAuthOrRejectSync, o as withResolvedWebhookRequestPipeline, r as registerWebhookTargetWithPluginRoute, s as normalizeWebhookPath } from "./inbound-envelope-DsNRW6ln.js";
import { a as isAllowedBlueBubblesSender, b as blueBubblesFetchWithTimeout, d as fetchBlueBubblesServerInfo, f as getCachedBlueBubblesPrivateApiStatus, i as formatBlueBubblesChatTarget, m as isBlueBubblesPrivateApiStatusEnabled, p as isBlueBubblesPrivateApiEnabled, r as extractHandleFromChatGuid, s as normalizeBlueBubblesHandle, u as parseBlueBubblesTarget, v as resolveBlueBubblesAccount, x as buildBlueBubblesApiUrl } from "./monitor-shared-Bf6JQzrD.js";
import { r as warnBlueBubbles, t as getBlueBubblesRuntime } from "./runtime-BoY6thtd.js";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto, { createHash, timingSafeEqual } from "node:crypto";
import fs$1 from "node:fs/promises";
//#region extensions/bluebubbles/src/account-resolve.ts
function resolveBlueBubblesServerAccount(params) {
	const account = resolveBlueBubblesAccount({
		cfg: params.cfg ?? {},
		accountId: params.accountId
	});
	const baseUrl = normalizeResolvedSecretInputString({
		value: params.serverUrl,
		path: "channels.bluebubbles.serverUrl"
	}) || normalizeResolvedSecretInputString({
		value: account.config.serverUrl,
		path: `channels.bluebubbles.accounts.${account.accountId}.serverUrl`
	});
	const password = normalizeResolvedSecretInputString({
		value: params.password,
		path: "channels.bluebubbles.password"
	}) || normalizeResolvedSecretInputString({
		value: account.config.password,
		path: `channels.bluebubbles.accounts.${account.accountId}.password`
	});
	if (!baseUrl) {throw new Error("BlueBubbles serverUrl is required");}
	if (!password) {throw new Error("BlueBubbles password is required");}
	return {
		baseUrl,
		password,
		accountId: account.accountId,
		allowPrivateNetwork: account.config.allowPrivateNetwork === true
	};
}
//#endregion
//#region extensions/bluebubbles/src/multipart.ts
function concatUint8Arrays(parts) {
	const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}
	return body;
}
async function postMultipartFormData(params) {
	const body = Buffer.from(concatUint8Arrays(params.parts));
	return await blueBubblesFetchWithTimeout(params.url, {
		method: "POST",
		headers: { "Content-Type": `multipart/form-data; boundary=${params.boundary}` },
		body
	}, params.timeoutMs);
}
async function assertMultipartActionOk(response, action) {
	if (response.ok) {return;}
	const errorText = await response.text().catch(() => "");
	throw new Error(`BlueBubbles ${action} failed (${response.status}): ${errorText || "unknown"}`);
}
//#endregion
//#region extensions/bluebubbles/src/send-helpers.ts
function resolveBlueBubblesSendTarget(raw) {
	const parsed = parseBlueBubblesTarget(raw);
	if (parsed.kind === "handle") {return {
		kind: "handle",
		address: normalizeBlueBubblesHandle(parsed.to),
		service: parsed.service
	};}
	if (parsed.kind === "chat_id") {return {
		kind: "chat_id",
		chatId: parsed.chatId
	};}
	if (parsed.kind === "chat_guid") {return {
		kind: "chat_guid",
		chatGuid: parsed.chatGuid
	};}
	return {
		kind: "chat_identifier",
		chatIdentifier: parsed.chatIdentifier
	};
}
function extractBlueBubblesMessageId(payload) {
	if (!payload || typeof payload !== "object") {return "unknown";}
	const asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
	const record = payload;
	const roots = [
		record,
		asRecord(record.data),
		asRecord(record.result),
		asRecord(record.payload),
		asRecord(record.message),
		Array.isArray(record.data) ? asRecord(record.data[0]) : null
	];
	for (const root of roots) {
		if (!root) {continue;}
		const candidates = [
			root.message_id,
			root.messageId,
			root.messageGuid,
			root.message_guid,
			root.guid,
			root.id,
			root.uuid
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim()) {return candidate.trim();}
			if (typeof candidate === "number" && Number.isFinite(candidate)) {return String(candidate);}
		}
	}
	return "unknown";
}
//#endregion
//#region extensions/bluebubbles/src/send.ts
/** Maps short effect names to full Apple effect IDs */
const EFFECT_MAP = {
	slam: "com.apple.MobileSMS.expressivesend.impact",
	loud: "com.apple.MobileSMS.expressivesend.loud",
	gentle: "com.apple.MobileSMS.expressivesend.gentle",
	invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
	"invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
	"invisible ink": "com.apple.MobileSMS.expressivesend.invisibleink",
	invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
	echo: "com.apple.messages.effect.CKEchoEffect",
	spotlight: "com.apple.messages.effect.CKSpotlightEffect",
	balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
	confetti: "com.apple.messages.effect.CKConfettiEffect",
	love: "com.apple.messages.effect.CKHeartEffect",
	heart: "com.apple.messages.effect.CKHeartEffect",
	hearts: "com.apple.messages.effect.CKHeartEffect",
	lasers: "com.apple.messages.effect.CKLasersEffect",
	fireworks: "com.apple.messages.effect.CKFireworksEffect",
	celebration: "com.apple.messages.effect.CKSparklesEffect"
};
function resolveEffectId(raw) {
	if (!raw) {return;}
	const trimmed = raw.trim().toLowerCase();
	if (EFFECT_MAP[trimmed]) {return EFFECT_MAP[trimmed];}
	const normalized = trimmed.replace(/[\s_]+/g, "-");
	if (EFFECT_MAP[normalized]) {return EFFECT_MAP[normalized];}
	const compact = trimmed.replace(/[\s_-]+/g, "");
	if (EFFECT_MAP[compact]) {return EFFECT_MAP[compact];}
	return raw;
}
function resolvePrivateApiDecision(params) {
	const { privateApiStatus, wantsReplyThread, wantsEffect } = params;
	const needsPrivateApi = wantsReplyThread || wantsEffect;
	const canUsePrivateApi = needsPrivateApi && isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
	const throwEffectDisabledError = wantsEffect && privateApiStatus === false;
	if (!needsPrivateApi || privateApiStatus !== null) {return {
		canUsePrivateApi,
		throwEffectDisabledError
	};}
	return {
		canUsePrivateApi,
		throwEffectDisabledError,
		warningMessage: `Private API status unknown; sending without ${[wantsReplyThread ? "reply threading" : null, wantsEffect ? "message effects" : null].filter(Boolean).join(" + ")}. Run a status probe to restore private-api features.`
	};
}
async function parseBlueBubblesMessageResponse(res) {
	const body = await res.text();
	if (!body) {return { messageId: "ok" };}
	try {
		return { messageId: extractBlueBubblesMessageId(JSON.parse(body)) };
	} catch {
		return { messageId: "ok" };
	}
}
function extractChatGuid(chat) {
	const candidates = [
		chat.chatGuid,
		chat.guid,
		chat.chat_guid,
		chat.identifier,
		chat.chatIdentifier,
		chat.chat_identifier
	];
	for (const candidate of candidates) {if (typeof candidate === "string" && candidate.trim()) return candidate.trim();}
	return null;
}
function extractChatId(chat) {
	const candidates = [
		chat.chatId,
		chat.id,
		chat.chat_id
	];
	for (const candidate of candidates) {if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;}
	return null;
}
function extractChatIdentifierFromChatGuid$1(chatGuid) {
	const parts = chatGuid.split(";");
	if (parts.length < 3) {return null;}
	const identifier = parts[2]?.trim();
	return identifier ? identifier : null;
}
function extractParticipantAddresses(chat) {
	const raw = (Array.isArray(chat.participants) ? chat.participants : null) ?? (Array.isArray(chat.handles) ? chat.handles : null) ?? (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
	if (!raw) {return [];}
	const out = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push(entry);
			continue;
		}
		if (entry && typeof entry === "object") {
			const record = entry;
			const candidate = typeof record.address === "string" && record.address || typeof record.handle === "string" && record.handle || typeof record.id === "string" && record.id || typeof record.identifier === "string" && record.identifier;
			if (candidate) {out.push(candidate);}
		}
	}
	return out;
}
async function queryChats(params) {
	const res = await blueBubblesFetchWithTimeout(buildBlueBubblesApiUrl({
		baseUrl: params.baseUrl,
		path: "/api/v1/chat/query",
		password: params.password
	}), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			limit: params.limit,
			offset: params.offset,
			with: ["participants"]
		})
	}, params.timeoutMs);
	if (!res.ok) {return [];}
	const payload = await res.json().catch(() => null);
	const data = payload && typeof payload.data !== "undefined" ? payload.data : null;
	return Array.isArray(data) ? data : [];
}
async function resolveChatGuidForTarget(params) {
	if (params.target.kind === "chat_guid") {return params.target.chatGuid;}
	const normalizedHandle = params.target.kind === "handle" ? normalizeBlueBubblesHandle(params.target.address) : "";
	const targetChatId = params.target.kind === "chat_id" ? params.target.chatId : null;
	const targetChatIdentifier = params.target.kind === "chat_identifier" ? params.target.chatIdentifier : null;
	const limit = 500;
	let participantMatch = null;
	for (let offset = 0; offset < 5e3; offset += limit) {
		const chats = await queryChats({
			baseUrl: params.baseUrl,
			password: params.password,
			timeoutMs: params.timeoutMs,
			offset,
			limit
		});
		if (chats.length === 0) {break;}
		for (const chat of chats) {
			if (targetChatId != null) {
				const chatId = extractChatId(chat);
				if (chatId != null && chatId === targetChatId) {return extractChatGuid(chat);}
			}
			if (targetChatIdentifier) {
				const guid = extractChatGuid(chat);
				if (guid) {
					if (guid === targetChatIdentifier) {return guid;}
					const guidIdentifier = extractChatIdentifierFromChatGuid$1(guid);
					if (guidIdentifier && guidIdentifier === targetChatIdentifier) {return guid;}
				}
				const identifier = typeof chat.identifier === "string" ? chat.identifier : typeof chat.chatIdentifier === "string" ? chat.chatIdentifier : typeof chat.chat_identifier === "string" ? chat.chat_identifier : "";
				if (identifier && identifier === targetChatIdentifier) {return guid ?? extractChatGuid(chat);}
			}
			if (normalizedHandle) {
				const guid = extractChatGuid(chat);
				const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
				if (directHandle && directHandle === normalizedHandle) {return guid;}
				if (!participantMatch && guid) {
					if (guid.includes(";-;")) {
						if (extractParticipantAddresses(chat).map((entry) => normalizeBlueBubblesHandle(entry)).includes(normalizedHandle)) {participantMatch = guid;}
					}
				}
			}
		}
	}
	return participantMatch;
}
/**
* Creates a new chat (DM) and optionally sends an initial message.
* Requires Private API to be enabled in BlueBubbles.
*/
async function createNewChatWithMessage(params) {
	const url = buildBlueBubblesApiUrl({
		baseUrl: params.baseUrl,
		path: "/api/v1/chat/new",
		password: params.password
	});
	const payload = {
		addresses: [params.address],
		message: params.message,
		tempGuid: `temp-${crypto.randomUUID()}`
	};
	const res = await blueBubblesFetchWithTimeout(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	}, params.timeoutMs);
	if (!res.ok) {
		const errorText = await res.text();
		if (res.status === 400 || res.status === 403 || errorText.toLowerCase().includes("private api")) {throw new Error(`BlueBubbles send failed: Cannot create new chat - Private API must be enabled. Original error: ${errorText || res.status}`);}
		throw new Error(`BlueBubbles create chat failed (${res.status}): ${errorText || "unknown"}`);
	}
	return parseBlueBubblesMessageResponse(res);
}
async function sendMessageBlueBubbles(to, text, opts = {}) {
	const trimmedText = text ?? "";
	if (!trimmedText.trim()) {throw new Error("BlueBubbles send requires text");}
	const strippedText = stripMarkdown(trimmedText);
	if (!strippedText.trim()) {throw new Error("BlueBubbles send requires text (message was empty after markdown removal)");}
	const account = resolveBlueBubblesAccount({
		cfg: opts.cfg ?? {},
		accountId: opts.accountId
	});
	const baseUrl = normalizeSecretInputString(opts.serverUrl) || normalizeSecretInputString(account.config.serverUrl);
	const password = normalizeSecretInputString(opts.password) || normalizeSecretInputString(account.config.password);
	if (!baseUrl) {throw new Error("BlueBubbles serverUrl is required");}
	if (!password) {throw new Error("BlueBubbles password is required");}
	const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(account.accountId);
	const target = resolveBlueBubblesSendTarget(to);
	const chatGuid = await resolveChatGuidForTarget({
		baseUrl,
		password,
		timeoutMs: opts.timeoutMs,
		target
	});
	if (!chatGuid) {
		if (target.kind === "handle") {return createNewChatWithMessage({
			baseUrl,
			password,
			address: target.address,
			message: strippedText,
			timeoutMs: opts.timeoutMs
		});}
		throw new Error("BlueBubbles send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.");
	}
	const effectId = resolveEffectId(opts.effectId);
	const wantsReplyThread = Boolean(opts.replyToMessageGuid?.trim());
	const privateApiDecision = resolvePrivateApiDecision({
		privateApiStatus,
		wantsReplyThread,
		wantsEffect: Boolean(effectId)
	});
	if (privateApiDecision.throwEffectDisabledError) {throw new Error("BlueBubbles send failed: reply/effect requires Private API, but it is disabled on the BlueBubbles server.");}
	if (privateApiDecision.warningMessage) {warnBlueBubbles(privateApiDecision.warningMessage);}
	const payload = {
		chatGuid,
		tempGuid: crypto.randomUUID(),
		message: strippedText
	};
	if (privateApiDecision.canUsePrivateApi) {payload.method = "private-api";}
	if (wantsReplyThread && privateApiDecision.canUsePrivateApi) {
		payload.selectedMessageGuid = opts.replyToMessageGuid;
		payload.partIndex = typeof opts.replyToPartIndex === "number" ? opts.replyToPartIndex : 0;
	}
	if (effectId && privateApiDecision.canUsePrivateApi) {payload.effectId = effectId;}
	const res = await blueBubblesFetchWithTimeout(buildBlueBubblesApiUrl({
		baseUrl,
		path: "/api/v1/message/text",
		password
	}), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	}, opts.timeoutMs);
	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`BlueBubbles send failed (${res.status}): ${errorText || "unknown"}`);
	}
	return parseBlueBubblesMessageResponse(res);
}
//#endregion
//#region extensions/bluebubbles/src/attachments.ts
const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const AUDIO_MIME_MP3 = new Set(["audio/mpeg", "audio/mp3"]);
const AUDIO_MIME_CAF = new Set(["audio/x-caf", "audio/caf"]);
function sanitizeFilename(input, fallback) {
	const trimmed = input?.trim() ?? "";
	return ((trimmed ? path.basename(trimmed) : "") || fallback).replace(/[\r\n"\\]/g, "_");
}
function ensureExtension(filename, extension, fallbackBase) {
	const currentExt = path.extname(filename);
	if (currentExt.toLowerCase() === extension) {return filename;}
	return `${(currentExt ? filename.slice(0, -currentExt.length) : filename) || fallbackBase}${extension}`;
}
function resolveVoiceInfo(filename, contentType) {
	const normalizedType = contentType?.trim().toLowerCase();
	const extension = path.extname(filename).toLowerCase();
	const isMp3 = extension === ".mp3" || (normalizedType ? AUDIO_MIME_MP3.has(normalizedType) : false);
	const isCaf = extension === ".caf" || (normalizedType ? AUDIO_MIME_CAF.has(normalizedType) : false);
	return {
		isAudio: isMp3 || isCaf || Boolean(normalizedType?.startsWith("audio/")),
		isMp3,
		isCaf
	};
}
function resolveAccount$3(params) {
	return resolveBlueBubblesServerAccount(params);
}
function safeExtractHostname(url) {
	try {
		return new URL(url).hostname.trim() || void 0;
	} catch {
		return;
	}
}
function readMediaFetchErrorCode(error) {
	if (!error || typeof error !== "object") {return;}
	const code = error.code;
	return code === "max_bytes" || code === "http_error" || code === "fetch_failed" ? code : void 0;
}
async function downloadBlueBubblesAttachment(attachment, opts = {}) {
	const guid = attachment.guid?.trim();
	if (!guid) {throw new Error("BlueBubbles attachment guid is required");}
	const { baseUrl, password, allowPrivateNetwork } = resolveAccount$3(opts);
	const url = buildBlueBubblesApiUrl({
		baseUrl,
		path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
		password
	});
	const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
	const trustedHostname = safeExtractHostname(baseUrl);
	try {
		const fetched = await getBlueBubblesRuntime().channel.media.fetchRemoteMedia({
			url,
			filePathHint: attachment.transferName ?? attachment.guid ?? "attachment",
			maxBytes,
			ssrfPolicy: allowPrivateNetwork ? { allowPrivateNetwork: true } : trustedHostname ? { allowedHostnames: [trustedHostname] } : void 0,
			fetchImpl: async (input, init) => await blueBubblesFetchWithTimeout(resolveRequestUrl(input), {
				...init,
				method: init?.method ?? "GET"
			}, opts.timeoutMs)
		});
		return {
			buffer: new Uint8Array(fetched.buffer),
			contentType: fetched.contentType ?? attachment.mimeType ?? void 0
		};
	} catch (error) {
		if (readMediaFetchErrorCode(error) === "max_bytes") {throw new Error(`BlueBubbles attachment too large (limit ${maxBytes} bytes)`);}
		const text = error instanceof Error ? error.message : String(error);
		throw new Error(`BlueBubbles attachment download failed: ${text}`, { cause: error });
	}
}
/**
* Send an attachment via BlueBubbles API.
* Supports sending media files (images, videos, audio, documents) to a chat.
* When asVoice is true, expects MP3/CAF audio and marks it as an iMessage voice memo.
*/
async function sendBlueBubblesAttachment(params) {
	const { to, caption, replyToMessageGuid, replyToPartIndex, asVoice, opts = {} } = params;
	let { buffer, filename, contentType } = params;
	const wantsVoice = asVoice === true;
	const fallbackName = wantsVoice ? "Audio Message" : "attachment";
	filename = sanitizeFilename(filename, fallbackName);
	contentType = contentType?.trim() || void 0;
	const { baseUrl, password, accountId } = resolveAccount$3(opts);
	const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);
	const privateApiEnabled = isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
	const isAudioMessage = wantsVoice;
	if (isAudioMessage) {
		const voiceInfo = resolveVoiceInfo(filename, contentType);
		if (!voiceInfo.isAudio) {throw new Error("BlueBubbles voice messages require audio media (mp3 or caf).");}
		if (voiceInfo.isMp3) {
			filename = ensureExtension(filename, ".mp3", fallbackName);
			contentType = contentType ?? "audio/mpeg";
		} else if (voiceInfo.isCaf) {
			filename = ensureExtension(filename, ".caf", fallbackName);
			contentType = contentType ?? "audio/x-caf";
		} else {throw new Error("BlueBubbles voice messages require mp3 or caf audio (convert before sending).");}
	}
	const target = resolveBlueBubblesSendTarget(to);
	const chatGuid = await resolveChatGuidForTarget({
		baseUrl,
		password,
		timeoutMs: opts.timeoutMs,
		target
	});
	if (!chatGuid) {throw new Error("BlueBubbles attachment send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.");}
	const url = buildBlueBubblesApiUrl({
		baseUrl,
		path: "/api/v1/message/attachment",
		password
	});
	const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
	const parts = [];
	const encoder = new TextEncoder();
	const addField = (name, value) => {
		parts.push(encoder.encode(`--${boundary}\r\n`));
		parts.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
		parts.push(encoder.encode(`${value}\r\n`));
	};
	const addFile = (name, fileBuffer, fileName, mimeType) => {
		parts.push(encoder.encode(`--${boundary}\r\n`));
		parts.push(encoder.encode(`Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n`));
		parts.push(encoder.encode(`Content-Type: ${mimeType ?? "application/octet-stream"}\r\n\r\n`));
		parts.push(fileBuffer);
		parts.push(encoder.encode("\r\n"));
	};
	addFile("attachment", buffer, filename, contentType);
	addField("chatGuid", chatGuid);
	addField("name", filename);
	addField("tempGuid", `temp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
	if (privateApiEnabled) {addField("method", "private-api");}
	if (isAudioMessage) {addField("isAudioMessage", "true");}
	const trimmedReplyTo = replyToMessageGuid?.trim();
	if (trimmedReplyTo && privateApiEnabled) {
		addField("selectedMessageGuid", trimmedReplyTo);
		addField("partIndex", typeof replyToPartIndex === "number" ? String(replyToPartIndex) : "0");
	} else if (trimmedReplyTo && privateApiStatus === null) {warnBlueBubbles("Private API status unknown; sending attachment without reply threading metadata. Run a status probe to restore private-api reply features.");}
	if (caption) {
		addField("message", caption);
		addField("text", caption);
		addField("caption", caption);
	}
	parts.push(encoder.encode(`--${boundary}--\r\n`));
	const res = await postMultipartFormData({
		url,
		boundary,
		parts,
		timeoutMs: opts.timeoutMs ?? 6e4
	});
	await assertMultipartActionOk(res, "attachment send");
	const responseBody = await res.text();
	if (!responseBody) {return { messageId: "ok" };}
	try {
		return { messageId: extractBlueBubblesMessageId(JSON.parse(responseBody)) };
	} catch {
		return { messageId: "ok" };
	}
}
//#endregion
//#region extensions/bluebubbles/src/chat.ts
function resolveAccount$2(params) {
	return resolveBlueBubblesServerAccount(params);
}
function assertPrivateApiEnabled(accountId, feature) {
	if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {throw new Error(`BlueBubbles ${feature} requires Private API, but it is disabled on the BlueBubbles server.`);}
}
function resolvePartIndex(partIndex) {
	return typeof partIndex === "number" ? partIndex : 0;
}
async function sendBlueBubblesChatEndpointRequest(params) {
	const trimmed = params.chatGuid.trim();
	if (!trimmed) {return;}
	const { baseUrl, password, accountId } = resolveAccount$2(params.opts);
	if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {return;}
	await assertMultipartActionOk(await blueBubblesFetchWithTimeout(buildBlueBubblesApiUrl({
		baseUrl,
		path: `/api/v1/chat/${encodeURIComponent(trimmed)}/${params.endpoint}`,
		password
	}), { method: params.method }, params.opts.timeoutMs), params.action);
}
async function sendPrivateApiJsonRequest(params) {
	const { baseUrl, password, accountId } = resolveAccount$2(params.opts);
	assertPrivateApiEnabled(accountId, params.feature);
	const url = buildBlueBubblesApiUrl({
		baseUrl,
		path: params.path,
		password
	});
	const request = { method: params.method };
	if (params.payload !== void 0) {
		request.headers = { "Content-Type": "application/json" };
		request.body = JSON.stringify(params.payload);
	}
	await assertMultipartActionOk(await blueBubblesFetchWithTimeout(url, request, params.opts.timeoutMs), params.action);
}
async function markBlueBubblesChatRead(chatGuid, opts = {}) {
	await sendBlueBubblesChatEndpointRequest({
		chatGuid,
		opts,
		endpoint: "read",
		method: "POST",
		action: "read"
	});
}
async function sendBlueBubblesTyping(chatGuid, typing, opts = {}) {
	await sendBlueBubblesChatEndpointRequest({
		chatGuid,
		opts,
		endpoint: "typing",
		method: typing ? "POST" : "DELETE",
		action: "typing"
	});
}
/**
* Edit a message via BlueBubbles API.
* Requires macOS 13 (Ventura) or higher with Private API enabled.
*/
async function editBlueBubblesMessage(messageGuid, newText, opts = {}) {
	const trimmedGuid = messageGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles edit requires messageGuid");}
	const trimmedText = newText.trim();
	if (!trimmedText) {throw new Error("BlueBubbles edit requires newText");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "edit",
		action: "edit",
		method: "POST",
		path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/edit`,
		payload: {
			editedMessage: trimmedText,
			backwardsCompatibilityMessage: opts.backwardsCompatMessage ?? `Edited to: ${trimmedText}`,
			partIndex: resolvePartIndex(opts.partIndex)
		}
	});
}
/**
* Unsend (retract) a message via BlueBubbles API.
* Requires macOS 13 (Ventura) or higher with Private API enabled.
*/
async function unsendBlueBubblesMessage(messageGuid, opts = {}) {
	const trimmedGuid = messageGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles unsend requires messageGuid");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "unsend",
		action: "unsend",
		method: "POST",
		path: `/api/v1/message/${encodeURIComponent(trimmedGuid)}/unsend`,
		payload: { partIndex: resolvePartIndex(opts.partIndex) }
	});
}
/**
* Rename a group chat via BlueBubbles API.
*/
async function renameBlueBubblesChat(chatGuid, displayName, opts = {}) {
	const trimmedGuid = chatGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles rename requires chatGuid");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "renameGroup",
		action: "rename",
		method: "PUT",
		path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}`,
		payload: { displayName }
	});
}
/**
* Add a participant to a group chat via BlueBubbles API.
*/
async function addBlueBubblesParticipant(chatGuid, address, opts = {}) {
	const trimmedGuid = chatGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles addParticipant requires chatGuid");}
	const trimmedAddress = address.trim();
	if (!trimmedAddress) {throw new Error("BlueBubbles addParticipant requires address");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "addParticipant",
		action: "addParticipant",
		method: "POST",
		path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
		payload: { address: trimmedAddress }
	});
}
/**
* Remove a participant from a group chat via BlueBubbles API.
*/
async function removeBlueBubblesParticipant(chatGuid, address, opts = {}) {
	const trimmedGuid = chatGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles removeParticipant requires chatGuid");}
	const trimmedAddress = address.trim();
	if (!trimmedAddress) {throw new Error("BlueBubbles removeParticipant requires address");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "removeParticipant",
		action: "removeParticipant",
		method: "DELETE",
		path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/participant`,
		payload: { address: trimmedAddress }
	});
}
/**
* Leave a group chat via BlueBubbles API.
*/
async function leaveBlueBubblesChat(chatGuid, opts = {}) {
	const trimmedGuid = chatGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles leaveChat requires chatGuid");}
	await sendPrivateApiJsonRequest({
		opts,
		feature: "leaveGroup",
		action: "leaveChat",
		method: "POST",
		path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/leave`
	});
}
/**
* Set a group chat's icon/photo via BlueBubbles API.
* Requires Private API to be enabled.
*/
async function setGroupIconBlueBubbles(chatGuid, buffer, filename, opts = {}) {
	const trimmedGuid = chatGuid.trim();
	if (!trimmedGuid) {throw new Error("BlueBubbles setGroupIcon requires chatGuid");}
	if (!buffer || buffer.length === 0) {throw new Error("BlueBubbles setGroupIcon requires image buffer");}
	const { baseUrl, password, accountId } = resolveAccount$2(opts);
	assertPrivateApiEnabled(accountId, "setGroupIcon");
	const url = buildBlueBubblesApiUrl({
		baseUrl,
		path: `/api/v1/chat/${encodeURIComponent(trimmedGuid)}/icon`,
		password
	});
	const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
	const parts = [];
	const encoder = new TextEncoder();
	const safeFilename = path.basename(filename).replace(/[\r\n"\\]/g, "_") || "icon.png";
	parts.push(encoder.encode(`--${boundary}\r\n`));
	parts.push(encoder.encode(`Content-Disposition: form-data; name="icon"; filename="${safeFilename}"\r\n`));
	parts.push(encoder.encode(`Content-Type: ${opts.contentType ?? "application/octet-stream"}\r\n\r\n`));
	parts.push(buffer);
	parts.push(encoder.encode("\r\n"));
	parts.push(encoder.encode(`--${boundary}--\r\n`));
	await assertMultipartActionOk(await postMultipartFormData({
		url,
		boundary,
		parts,
		timeoutMs: opts.timeoutMs ?? 6e4
	}), "setGroupIcon");
}
//#endregion
//#region extensions/bluebubbles/src/monitor-debounce.ts
/**
* Default debounce window for inbound message coalescing (ms).
* This helps combine URL text + link preview balloon messages that BlueBubbles
* sends as separate webhook events when no explicit inbound debounce config exists.
*/
const DEFAULT_INBOUND_DEBOUNCE_MS = 500;
/**
* Combines multiple debounced messages into a single message for processing.
* Used when multiple webhook events arrive within the debounce window.
*/
function combineDebounceEntries(entries) {
	if (entries.length === 0) {throw new Error("Cannot combine empty entries");}
	if (entries.length === 1) {return entries[0].message;}
	const first = entries[0].message;
	const seenTexts = /* @__PURE__ */ new Set();
	const textParts = [];
	for (const entry of entries) {
		const text = entry.message.text.trim();
		if (!text) {continue;}
		const normalizedText = text.toLowerCase();
		if (seenTexts.has(normalizedText)) {continue;}
		seenTexts.add(normalizedText);
		textParts.push(text);
	}
	const allAttachments = entries.flatMap((e) => e.message.attachments ?? []);
	const timestamps = entries.map((e) => e.message.timestamp).filter((t) => typeof t === "number");
	const latestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : first.timestamp;
	const messageIds = entries.map((e) => e.message.messageId).filter((id) => Boolean(id));
	const entryWithReply = entries.find((e) => e.message.replyToId);
	return {
		...first,
		text: textParts.join(" "),
		attachments: allAttachments.length > 0 ? allAttachments : first.attachments,
		timestamp: latestTimestamp,
		messageId: messageIds[0] ?? first.messageId,
		replyToId: entryWithReply?.message.replyToId ?? first.replyToId,
		replyToBody: entryWithReply?.message.replyToBody ?? first.replyToBody,
		replyToSender: entryWithReply?.message.replyToSender ?? first.replyToSender,
		balloonBundleId: void 0
	};
}
function resolveBlueBubblesDebounceMs(config, core) {
	const inbound = config.messages?.inbound;
	if (!(typeof inbound?.debounceMs === "number" || typeof inbound?.byChannel?.bluebubbles === "number")) {return DEFAULT_INBOUND_DEBOUNCE_MS;}
	return core.channel.debounce.resolveInboundDebounceMs({
		cfg: config,
		channel: "bluebubbles"
	});
}
function createBlueBubblesDebounceRegistry(params) {
	const targetDebouncers = /* @__PURE__ */ new Map();
	return {
		getOrCreateDebouncer: (target) => {
			const existing = targetDebouncers.get(target);
			if (existing) {return existing;}
			const { account, config, runtime, core } = target;
			const debouncer = core.channel.debounce.createInboundDebouncer({
				debounceMs: resolveBlueBubblesDebounceMs(config, core),
				buildKey: (entry) => {
					const msg = entry.message;
					const balloonBundleId = msg.balloonBundleId?.trim();
					const associatedMessageGuid = msg.associatedMessageGuid?.trim();
					if (balloonBundleId && associatedMessageGuid) {return `bluebubbles:${account.accountId}:balloon:${associatedMessageGuid}`;}
					const messageId = msg.messageId?.trim();
					if (messageId) {return `bluebubbles:${account.accountId}:msg:${messageId}`;}
					const chatKey = msg.chatGuid?.trim() ?? msg.chatIdentifier?.trim() ?? (msg.chatId ? String(msg.chatId) : "dm");
					return `bluebubbles:${account.accountId}:${chatKey}:${msg.senderId}`;
				},
				shouldDebounce: (entry) => {
					const msg = entry.message;
					if (msg.fromMe) {return false;}
					if (core.channel.text.hasControlCommand(msg.text, config)) {return false;}
					return true;
				},
				onFlush: async (entries) => {
					if (entries.length === 0) {return;}
					const flushTarget = entries[0].target;
					if (entries.length === 1) {
						await params.processMessage(entries[0].message, flushTarget);
						return;
					}
					const combined = combineDebounceEntries(entries);
					if (core.logging.shouldLogVerbose()) {
						const count = entries.length;
						const preview = combined.text.slice(0, 50);
						runtime.log?.(`[bluebubbles] coalesced ${count} messages: "${preview}${combined.text.length > 50 ? "..." : ""}"`);
					}
					await params.processMessage(combined, flushTarget);
				},
				onError: (err) => {
					runtime.error?.(`[${account.accountId}] [bluebubbles] debounce flush failed: ${String(err)}`);
				}
			});
			targetDebouncers.set(target, debouncer);
			return debouncer;
		},
		removeDebouncer: (target) => {
			targetDebouncers.delete(target);
		}
	};
}
//#endregion
//#region extensions/bluebubbles/src/monitor-normalize.ts
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readString(record, key) {
	if (!record) {return;}
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function readNumber(record, key) {
	if (!record) {return;}
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function readBoolean(record, key) {
	if (!record) {return;}
	const value = record[key];
	return typeof value === "boolean" ? value : void 0;
}
function readNumberLike(record, key) {
	if (!record) {return;}
	return parseFiniteNumber(record[key]);
}
function extractAttachments(message) {
	const raw = message["attachments"];
	if (!Array.isArray(raw)) {return [];}
	const out = [];
	for (const entry of raw) {
		const record = asRecord$1(entry);
		if (!record) {continue;}
		out.push({
			guid: readString(record, "guid"),
			uti: readString(record, "uti"),
			mimeType: readString(record, "mimeType") ?? readString(record, "mime_type"),
			transferName: readString(record, "transferName") ?? readString(record, "transfer_name"),
			totalBytes: readNumberLike(record, "totalBytes") ?? readNumberLike(record, "total_bytes"),
			height: readNumberLike(record, "height"),
			width: readNumberLike(record, "width"),
			originalROWID: readNumberLike(record, "originalROWID") ?? readNumberLike(record, "rowid")
		});
	}
	return out;
}
function buildAttachmentPlaceholder(attachments) {
	if (attachments.length === 0) {return "";}
	const mimeTypes = attachments.map((entry) => entry.mimeType ?? "");
	const allImages = mimeTypes.every((entry) => entry.startsWith("image/"));
	const allVideos = mimeTypes.every((entry) => entry.startsWith("video/"));
	const allAudio = mimeTypes.every((entry) => entry.startsWith("audio/"));
	const tag = allImages ? "<media:image>" : allVideos ? "<media:video>" : allAudio ? "<media:audio>" : "<media:attachment>";
	const label = allImages ? "image" : allVideos ? "video" : allAudio ? "audio" : "file";
	const suffix = attachments.length === 1 ? label : `${label}s`;
	return `${tag} (${attachments.length} ${suffix})`;
}
function buildMessagePlaceholder(message) {
	const attachmentPlaceholder = buildAttachmentPlaceholder(message.attachments ?? []);
	if (attachmentPlaceholder) {return attachmentPlaceholder;}
	if (message.balloonBundleId) {return "<media:sticker>";}
	return "";
}
function formatReplyTag(message) {
	const rawId = message.replyToShortId || message.replyToId;
	if (!rawId) {return null;}
	return `[[reply_to:${rawId}]]`;
}
function extractReplyMetadata(message) {
	const replyRecord = asRecord$1(message["replyTo"] ?? message["reply_to"] ?? message["replyToMessage"] ?? message["reply_to_message"] ?? message["repliedMessage"] ?? message["quotedMessage"] ?? message["associatedMessage"] ?? message["reply"]);
	const replyHandle = asRecord$1(replyRecord?.["handle"]) ?? asRecord$1(replyRecord?.["sender"]) ?? null;
	const replySenderRaw = readString(replyHandle, "address") ?? readString(replyHandle, "handle") ?? readString(replyHandle, "id") ?? readString(replyRecord, "senderId") ?? readString(replyRecord, "sender") ?? readString(replyRecord, "from");
	const normalizedSender = replySenderRaw ? normalizeBlueBubblesHandle(replySenderRaw) || replySenderRaw.trim() : void 0;
	const replyToBody = readString(replyRecord, "text") ?? readString(replyRecord, "body") ?? readString(replyRecord, "message") ?? readString(replyRecord, "subject") ?? void 0;
	const directReplyId = readString(message, "replyToMessageGuid") ?? readString(message, "replyToGuid") ?? readString(message, "replyGuid") ?? readString(message, "selectedMessageGuid") ?? readString(message, "selectedMessageId") ?? readString(message, "replyToMessageId") ?? readString(message, "replyId") ?? readString(replyRecord, "guid") ?? readString(replyRecord, "id") ?? readString(replyRecord, "messageId");
	const associatedType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
	const associatedGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId");
	const isReactionAssociation = typeof associatedType === "number" && REACTION_TYPE_MAP.has(associatedType);
	const replyToId = directReplyId ?? (!isReactionAssociation ? associatedGuid : void 0);
	const threadOriginatorGuid = readString(message, "threadOriginatorGuid");
	const messageGuid = readString(message, "guid");
	return {
		replyToId: (replyToId ?? (!replyToId && threadOriginatorGuid && threadOriginatorGuid !== messageGuid ? threadOriginatorGuid : void 0))?.trim() || void 0,
		replyToBody: replyToBody?.trim() || void 0,
		replyToSender: normalizedSender || void 0
	};
}
function readFirstChatRecord(message) {
	const chats = message["chats"];
	if (!Array.isArray(chats) || chats.length === 0) {return null;}
	const first = chats[0];
	return asRecord$1(first);
}
function extractSenderInfo(message) {
	const handleValue = message.handle ?? message.sender;
	const handle = asRecord$1(handleValue) ?? (typeof handleValue === "string" ? { address: handleValue } : null);
	const senderId = (readString(handle, "address") ?? readString(handle, "handle") ?? readString(handle, "id") ?? readString(message, "senderId") ?? readString(message, "sender") ?? readString(message, "from") ?? "").trim();
	const senderName = readString(handle, "displayName") ?? readString(handle, "name") ?? readString(message, "senderName") ?? void 0;
	return {
		senderId,
		senderIdExplicit: Boolean(senderId),
		senderName
	};
}
function extractChatContext(message) {
	const chat = asRecord$1(message.chat) ?? asRecord$1(message.conversation) ?? null;
	const chatFromList = readFirstChatRecord(message);
	const chatGuid = readString(message, "chatGuid") ?? readString(message, "chat_guid") ?? readString(chat, "chatGuid") ?? readString(chat, "chat_guid") ?? readString(chat, "guid") ?? readString(chatFromList, "chatGuid") ?? readString(chatFromList, "chat_guid") ?? readString(chatFromList, "guid");
	const chatIdentifier = readString(message, "chatIdentifier") ?? readString(message, "chat_identifier") ?? readString(chat, "chatIdentifier") ?? readString(chat, "chat_identifier") ?? readString(chat, "identifier") ?? readString(chatFromList, "chatIdentifier") ?? readString(chatFromList, "chat_identifier") ?? readString(chatFromList, "identifier") ?? extractChatIdentifierFromChatGuid(chatGuid);
	const chatId = readNumberLike(message, "chatId") ?? readNumberLike(message, "chat_id") ?? readNumberLike(chat, "chatId") ?? readNumberLike(chat, "chat_id") ?? readNumberLike(chat, "id") ?? readNumberLike(chatFromList, "chatId") ?? readNumberLike(chatFromList, "chat_id") ?? readNumberLike(chatFromList, "id");
	const chatName = readString(message, "chatName") ?? readString(chat, "displayName") ?? readString(chat, "name") ?? readString(chatFromList, "displayName") ?? readString(chatFromList, "name") ?? void 0;
	const chatParticipants = chat ? chat["participants"] : void 0;
	const messageParticipants = message["participants"];
	const chatsParticipants = chatFromList ? chatFromList["participants"] : void 0;
	const participants = Array.isArray(chatParticipants) ? chatParticipants : Array.isArray(messageParticipants) ? messageParticipants : Array.isArray(chatsParticipants) ? chatsParticipants : [];
	const participantsCount = participants.length;
	const groupFromChatGuid = resolveGroupFlagFromChatGuid(chatGuid);
	const explicitIsGroup = readBoolean(message, "isGroup") ?? readBoolean(message, "is_group") ?? readBoolean(chat, "isGroup") ?? readBoolean(message, "group");
	return {
		chatGuid,
		chatIdentifier,
		chatId,
		chatName,
		isGroup: typeof groupFromChatGuid === "boolean" ? groupFromChatGuid : explicitIsGroup ?? participantsCount > 2,
		participants
	};
}
function normalizeParticipantEntry(entry) {
	if (typeof entry === "string" || typeof entry === "number") {
		const raw = String(entry).trim();
		if (!raw) {return null;}
		const normalized = normalizeBlueBubblesHandle(raw) || raw;
		return normalized ? { id: normalized } : null;
	}
	const record = asRecord$1(entry);
	if (!record) {return null;}
	const nestedHandle = asRecord$1(record["handle"]) ?? asRecord$1(record["sender"]) ?? asRecord$1(record["contact"]) ?? null;
	const idRaw = readString(record, "address") ?? readString(record, "handle") ?? readString(record, "id") ?? readString(record, "phoneNumber") ?? readString(record, "phone_number") ?? readString(record, "email") ?? readString(nestedHandle, "address") ?? readString(nestedHandle, "handle") ?? readString(nestedHandle, "id");
	const nameRaw = readString(record, "displayName") ?? readString(record, "name") ?? readString(record, "title") ?? readString(nestedHandle, "displayName") ?? readString(nestedHandle, "name");
	const normalizedId = idRaw ? normalizeBlueBubblesHandle(idRaw) || idRaw.trim() : "";
	if (!normalizedId) {return null;}
	return {
		id: normalizedId,
		name: nameRaw?.trim() || void 0
	};
}
function normalizeParticipantList(raw) {
	if (!Array.isArray(raw) || raw.length === 0) {return [];}
	const seen = /* @__PURE__ */ new Set();
	const output = [];
	for (const entry of raw) {
		const normalized = normalizeParticipantEntry(entry);
		if (!normalized?.id) {continue;}
		const key = normalized.id.toLowerCase();
		if (seen.has(key)) {continue;}
		seen.add(key);
		output.push(normalized);
	}
	return output;
}
function formatGroupMembers(params) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const entry of params.participants ?? []) {
		if (!entry?.id) {continue;}
		const key = entry.id.toLowerCase();
		if (seen.has(key)) {continue;}
		seen.add(key);
		ordered.push(entry);
	}
	if (ordered.length === 0 && params.fallback?.id) {ordered.push(params.fallback);}
	if (ordered.length === 0) {return;}
	return ordered.map((entry) => entry.name ? `${entry.name} (${entry.id})` : entry.id).join(", ");
}
function resolveGroupFlagFromChatGuid(chatGuid) {
	const guid = chatGuid?.trim();
	if (!guid) {return;}
	const parts = guid.split(";");
	if (parts.length >= 3) {
		if (parts[1] === "+") {return true;}
		if (parts[1] === "-") {return false;}
	}
	if (guid.includes(";+;")) {return true;}
	if (guid.includes(";-;")) {return false;}
}
function extractChatIdentifierFromChatGuid(chatGuid) {
	const guid = chatGuid?.trim();
	if (!guid) {return;}
	const parts = guid.split(";");
	if (parts.length < 3) {return;}
	return parts[2]?.trim() || void 0;
}
function formatGroupAllowlistEntry(params) {
	const guid = params.chatGuid?.trim();
	if (guid) {return `chat_guid:${guid}`;}
	const chatId = params.chatId;
	if (typeof chatId === "number" && Number.isFinite(chatId)) {return `chat_id:${chatId}`;}
	const identifier = params.chatIdentifier?.trim();
	if (identifier) {return `chat_identifier:${identifier}`;}
	return null;
}
const REACTION_TYPE_MAP = new Map([
	[2e3, {
		emoji: "❤️",
		action: "added"
	}],
	[2001, {
		emoji: "👍",
		action: "added"
	}],
	[2002, {
		emoji: "👎",
		action: "added"
	}],
	[2003, {
		emoji: "😂",
		action: "added"
	}],
	[2004, {
		emoji: "‼️",
		action: "added"
	}],
	[2005, {
		emoji: "❓",
		action: "added"
	}],
	[3e3, {
		emoji: "❤️",
		action: "removed"
	}],
	[3001, {
		emoji: "👍",
		action: "removed"
	}],
	[3002, {
		emoji: "👎",
		action: "removed"
	}],
	[3003, {
		emoji: "😂",
		action: "removed"
	}],
	[3004, {
		emoji: "‼️",
		action: "removed"
	}],
	[3005, {
		emoji: "❓",
		action: "removed"
	}]
]);
const TAPBACK_TEXT_MAP = new Map([
	["loved", {
		emoji: "❤️",
		action: "added"
	}],
	["liked", {
		emoji: "👍",
		action: "added"
	}],
	["disliked", {
		emoji: "👎",
		action: "added"
	}],
	["laughed at", {
		emoji: "😂",
		action: "added"
	}],
	["emphasized", {
		emoji: "‼️",
		action: "added"
	}],
	["questioned", {
		emoji: "❓",
		action: "added"
	}],
	["removed a heart from", {
		emoji: "❤️",
		action: "removed"
	}],
	["removed a like from", {
		emoji: "👍",
		action: "removed"
	}],
	["removed a dislike from", {
		emoji: "👎",
		action: "removed"
	}],
	["removed a laugh from", {
		emoji: "😂",
		action: "removed"
	}],
	["removed an emphasis from", {
		emoji: "‼️",
		action: "removed"
	}],
	["removed a question from", {
		emoji: "❓",
		action: "removed"
	}]
]);
const TAPBACK_EMOJI_REGEX = /(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/u;
function extractFirstEmoji(text) {
	const match = text.match(TAPBACK_EMOJI_REGEX);
	return match ? match[0] : null;
}
function extractQuotedTapbackText(text) {
	const match = text.match(/[“"]([^”"]+)[”"]/s);
	return match ? match[1] : null;
}
function isTapbackAssociatedType(type) {
	return typeof type === "number" && Number.isFinite(type) && type >= 2e3 && type < 4e3;
}
function resolveTapbackActionHint(type) {
	if (typeof type !== "number" || !Number.isFinite(type)) {return;}
	if (type >= 3e3 && type < 4e3) {return "removed";}
	if (type >= 2e3 && type < 3e3) {return "added";}
}
function resolveTapbackContext(message) {
	const associatedType = message.associatedMessageType;
	const hasTapbackType = isTapbackAssociatedType(associatedType);
	const hasTapbackMarker = Boolean(message.associatedMessageEmoji) || Boolean(message.isTapback);
	if (!hasTapbackType && !hasTapbackMarker) {return null;}
	const replyToId = message.associatedMessageGuid?.trim() || message.replyToId?.trim() || void 0;
	const actionHint = resolveTapbackActionHint(associatedType);
	return {
		emojiHint: message.associatedMessageEmoji?.trim() || REACTION_TYPE_MAP.get(associatedType ?? -1)?.emoji,
		actionHint,
		replyToId
	};
}
function parseTapbackText(params) {
	const trimmed = params.text.trim();
	const lower = trimmed.toLowerCase();
	if (!trimmed) {return null;}
	const parseLeadingReactionAction = (prefix, defaultAction) => {
		if (!lower.startsWith(prefix)) {return null;}
		const emoji = extractFirstEmoji(trimmed) ?? params.emojiHint;
		if (!emoji) {return null;}
		const quotedText = extractQuotedTapbackText(trimmed);
		if (params.requireQuoted && !quotedText) {return null;}
		const fallback = trimmed.slice(prefix.length).trim();
		return {
			emoji,
			action: params.actionHint ?? defaultAction,
			quotedText: quotedText ?? fallback
		};
	};
	for (const [pattern, { emoji, action }] of TAPBACK_TEXT_MAP) {if (lower.startsWith(pattern)) {
		const afterPattern = trimmed.slice(pattern.length).trim();
		if (params.requireQuoted) {
			const strictMatch = afterPattern.match(/^[“"](.+)[”"]$/s);
			if (!strictMatch) return null;
			return {
				emoji,
				action,
				quotedText: strictMatch[1]
			};
		}
		return {
			emoji,
			action,
			quotedText: extractQuotedTapbackText(afterPattern) ?? extractQuotedTapbackText(trimmed) ?? afterPattern
		};
	}}
	const reacted = parseLeadingReactionAction("reacted", "added");
	if (reacted) {return reacted;}
	const removed = parseLeadingReactionAction("removed", "removed");
	if (removed) {return removed;}
	return null;
}
function extractMessagePayload(payload) {
	const parseRecord = (value) => {
		const record = asRecord$1(value);
		if (record) {return record;}
		if (Array.isArray(value)) {
			for (const entry of value) {
				const parsedEntry = parseRecord(entry);
				if (parsedEntry) {return parsedEntry;}
			}
			return null;
		}
		if (typeof value !== "string") {return null;}
		const trimmed = value.trim();
		if (!trimmed) {return null;}
		try {
			return parseRecord(JSON.parse(trimmed));
		} catch {
			return null;
		}
	};
	const data = parseRecord(payload.data ?? payload.payload ?? payload.event);
	const message = parseRecord(payload.message ?? data?.message ?? data);
	if (message) {return message;}
	return null;
}
function normalizeWebhookMessage(payload) {
	const message = extractMessagePayload(payload);
	if (!message) {return null;}
	const text = readString(message, "text") ?? readString(message, "body") ?? readString(message, "subject") ?? "";
	const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
	const { chatGuid, chatIdentifier, chatId, chatName, isGroup, participants } = extractChatContext(message);
	const normalizedParticipants = normalizeParticipantList(participants);
	const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
	const messageId = readString(message, "guid") ?? readString(message, "id") ?? readString(message, "messageId") ?? void 0;
	const balloonBundleId = readString(message, "balloonBundleId");
	const associatedMessageGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId") ?? void 0;
	const associatedMessageType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
	const associatedMessageEmoji = readString(message, "associatedMessageEmoji") ?? readString(message, "associated_message_emoji") ?? readString(message, "reactionEmoji") ?? readString(message, "reaction_emoji") ?? void 0;
	const isTapback = readBoolean(message, "isTapback") ?? readBoolean(message, "is_tapback") ?? readBoolean(message, "tapback") ?? void 0;
	const timestampRaw = readNumber(message, "date") ?? readNumber(message, "dateCreated") ?? readNumber(message, "timestamp");
	const timestamp = typeof timestampRaw === "number" ? timestampRaw > 0xe8d4a51000 ? timestampRaw : timestampRaw * 1e3 : void 0;
	const senderFallbackFromChatGuid = !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
	const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
	if (!normalizedSender) {return null;}
	const replyMetadata = extractReplyMetadata(message);
	return {
		text,
		senderId: normalizedSender,
		senderIdExplicit,
		senderName,
		messageId,
		timestamp,
		isGroup,
		chatId,
		chatGuid,
		chatIdentifier,
		chatName,
		fromMe,
		attachments: extractAttachments(message),
		balloonBundleId,
		associatedMessageGuid,
		associatedMessageType,
		associatedMessageEmoji,
		isTapback,
		participants: normalizedParticipants,
		replyToId: replyMetadata.replyToId,
		replyToBody: replyMetadata.replyToBody,
		replyToSender: replyMetadata.replyToSender
	};
}
function normalizeWebhookReaction(payload) {
	const message = extractMessagePayload(payload);
	if (!message) {return null;}
	const associatedGuid = readString(message, "associatedMessageGuid") ?? readString(message, "associated_message_guid") ?? readString(message, "associatedMessageId");
	const associatedType = readNumberLike(message, "associatedMessageType") ?? readNumberLike(message, "associated_message_type");
	if (!associatedGuid || associatedType === void 0) {return null;}
	const mapping = REACTION_TYPE_MAP.get(associatedType);
	const emoji = ((readString(message, "associatedMessageEmoji") ?? readString(message, "associated_message_emoji") ?? readString(message, "reactionEmoji") ?? readString(message, "reaction_emoji"))?.trim() || mapping?.emoji) ?? `reaction:${associatedType}`;
	const action = mapping?.action ?? resolveTapbackActionHint(associatedType) ?? "added";
	const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
	const { chatGuid, chatIdentifier, chatId, chatName, isGroup } = extractChatContext(message);
	const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
	const timestampRaw = readNumberLike(message, "date") ?? readNumberLike(message, "dateCreated") ?? readNumberLike(message, "timestamp");
	const timestamp = typeof timestampRaw === "number" ? timestampRaw > 0xe8d4a51000 ? timestampRaw : timestampRaw * 1e3 : void 0;
	const senderFallbackFromChatGuid = !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
	const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
	if (!normalizedSender) {return null;}
	return {
		action,
		emoji,
		senderId: normalizedSender,
		senderIdExplicit,
		senderName,
		messageId: associatedGuid,
		timestamp,
		isGroup,
		chatId,
		chatGuid,
		chatIdentifier,
		chatName,
		fromMe
	};
}
//#endregion
//#region extensions/bluebubbles/src/history.ts
function resolveAccount$1(params) {
	return resolveBlueBubblesServerAccount(params);
}
const MAX_HISTORY_FETCH_LIMIT = 100;
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
const MAX_HISTORY_BODY_CHARS = 2e3;
function clampHistoryLimit(limit) {
	if (!Number.isFinite(limit)) {return 0;}
	const normalized = Math.floor(limit);
	if (normalized <= 0) {return 0;}
	return Math.min(normalized, MAX_HISTORY_FETCH_LIMIT);
}
function truncateHistoryBody$1(text) {
	if (text.length <= MAX_HISTORY_BODY_CHARS) {return text;}
	return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}
/**
* Fetch message history from BlueBubbles API for a specific chat.
* This provides the initial backfill for both group chats and DMs.
*/
async function fetchBlueBubblesHistory(chatIdentifier, limit, opts = {}) {
	const effectiveLimit = clampHistoryLimit(limit);
	if (!chatIdentifier.trim() || effectiveLimit <= 0) {return {
		entries: [],
		resolved: true
	};}
	let baseUrl;
	let password;
	try {
		({baseUrl, password} = resolveAccount$1(opts));
	} catch {
		return {
			entries: [],
			resolved: false
		};
	}
	const possiblePaths = [
		`/api/v1/chat/${encodeURIComponent(chatIdentifier)}/messages?limit=${effectiveLimit}&sort=DESC`,
		`/api/v1/messages?chatGuid=${encodeURIComponent(chatIdentifier)}&limit=${effectiveLimit}`,
		`/api/v1/chat/${encodeURIComponent(chatIdentifier)}/message?limit=${effectiveLimit}`
	];
	for (const path of possiblePaths) {try {
		const res = await blueBubblesFetchWithTimeout(buildBlueBubblesApiUrl({
			baseUrl,
			path,
			password
		}), { method: "GET" }, opts.timeoutMs ?? 1e4);
		if (!res.ok) continue;
		const data = await res.json().catch(() => null);
		if (!data) continue;
		let messages = [];
		if (Array.isArray(data)) messages = data;
		else if (data.data && Array.isArray(data.data)) messages = data.data;
		else if (data.messages && Array.isArray(data.messages)) messages = data.messages;
		else continue;
		const historyEntries = [];
		const maxScannedMessages = Math.min(Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit), MAX_HISTORY_SCAN_MESSAGES);
		for (let i = 0; i < messages.length && i < maxScannedMessages; i++) {
			const msg = messages[i];
			const text = msg.text?.trim();
			if (!text) continue;
			const sender = msg.is_from_me ? "me" : msg.sender?.display_name || msg.sender?.address || msg.handle_id || "Unknown";
			const timestamp = msg.date_created || msg.date_delivered;
			historyEntries.push({
				sender,
				body: truncateHistoryBody$1(text),
				timestamp,
				messageId: msg.guid
			});
		}
		historyEntries.sort((a, b) => {
			return (a.timestamp || 0) - (b.timestamp || 0);
		});
		return {
			entries: historyEntries.slice(0, effectiveLimit),
			resolved: true
		};
	} catch (error) {
		continue;
	}}
	return {
		entries: [],
		resolved: false
	};
}
//#endregion
//#region extensions/bluebubbles/src/media-send.ts
const HTTP_URL_RE = /^https?:\/\//i;
const MB = 1024 * 1024;
function assertMediaWithinLimit(sizeBytes, maxBytes) {
	if (typeof maxBytes !== "number" || maxBytes <= 0) {return;}
	if (sizeBytes <= maxBytes) {return;}
	const maxLabel = (maxBytes / MB).toFixed(0);
	const sizeLabel = (sizeBytes / MB).toFixed(2);
	throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
}
function resolveLocalMediaPath(source) {
	if (!source.startsWith("file://")) {return source;}
	try {
		return fileURLToPath(source);
	} catch {
		throw new Error(`Invalid file:// URL: ${source}`);
	}
}
function expandHomePath(input) {
	if (input === "~") {return os.homedir();}
	if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) {return path.join(os.homedir(), input.slice(2));}
	return input;
}
function resolveConfiguredPath(input) {
	const trimmed = input.trim();
	if (!trimmed) {throw new Error("Empty mediaLocalRoots entry is not allowed");}
	if (trimmed.startsWith("file://")) {
		let parsed;
		try {
			parsed = fileURLToPath(trimmed);
		} catch {
			throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
		}
		if (!path.isAbsolute(parsed)) {throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);}
		return parsed;
	}
	const resolved = expandHomePath(trimmed);
	if (!path.isAbsolute(resolved)) {throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);}
	return resolved;
}
function isPathInsideRoot(candidate, root) {
	const normalizedCandidate = path.normalize(candidate);
	const normalizedRoot = path.normalize(root);
	const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
	if (process.platform === "win32") {
		const candidateLower = normalizedCandidate.toLowerCase();
		const rootLower = normalizedRoot.toLowerCase();
		const rootWithSepLower = rootWithSep.toLowerCase();
		return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
	}
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}
function resolveMediaLocalRoots(params) {
	return (resolveBlueBubblesAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.mediaLocalRoots ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
async function assertLocalMediaPathAllowed(params) {
	if (params.localRoots.length === 0) {throw new Error(`Local BlueBubbles media paths are disabled by default. Set channels.bluebubbles.mediaLocalRoots${params.accountId ? ` or channels.bluebubbles.accounts.${params.accountId}.mediaLocalRoots` : ""} to explicitly allow local file directories.`);}
	const resolvedLocalPath = path.resolve(params.localPath);
	const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in constants;
	const openFlags = constants.O_RDONLY | (supportsNoFollow ? constants.O_NOFOLLOW : 0);
	for (const rootEntry of params.localRoots) {
		const resolvedRootInput = resolveConfiguredPath(rootEntry);
		const relativeToRoot = path.relative(resolvedRootInput, resolvedLocalPath);
		if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || relativeToRoot === "") {continue;}
		let rootReal;
		try {
			rootReal = await fs$1.realpath(resolvedRootInput);
		} catch {
			rootReal = path.resolve(resolvedRootInput);
		}
		const candidatePath = path.resolve(rootReal, relativeToRoot);
		if (!isPathInsideRoot(candidatePath, rootReal)) {continue;}
		let handle = null;
		try {
			handle = await fs$1.open(candidatePath, openFlags);
			const realPath = await fs$1.realpath(candidatePath);
			if (!isPathInsideRoot(realPath, rootReal)) {continue;}
			const stat = await handle.stat();
			if (!stat.isFile()) {continue;}
			const realStat = await fs$1.stat(realPath);
			if (stat.ino !== realStat.ino || stat.dev !== realStat.dev) {continue;}
			return {
				data: await handle.readFile(),
				realPath,
				sizeBytes: stat.size
			};
		} catch {
			continue;
		} finally {
			if (handle) {await handle.close().catch(() => {});}
		}
	}
	throw new Error(`Local media path is not under any configured mediaLocalRoots entry: ${params.localPath}`);
}
function resolveFilenameFromSource(source) {
	if (!source) {return;}
	if (source.startsWith("file://")) {try {
		return path.basename(fileURLToPath(source)) || void 0;
	} catch {
		return;
	}}
	if (HTTP_URL_RE.test(source)) {try {
		return path.basename(new URL(source).pathname) || void 0;
	} catch {
		return;
	}}
	return path.basename(source) || void 0;
}
async function sendBlueBubblesMedia(params) {
	const { cfg, to, mediaUrl, mediaPath, mediaBuffer, contentType, filename, caption, replyToId, accountId, asVoice } = params;
	const core = getBlueBubblesRuntime();
	const maxBytes = resolveChannelMediaMaxBytes({
		cfg,
		resolveChannelLimitMb: ({ cfg, accountId }) => cfg.channels?.bluebubbles?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.bluebubbles?.mediaMaxMb,
		accountId
	});
	const mediaLocalRoots = resolveMediaLocalRoots({
		cfg,
		accountId
	});
	let buffer;
	let resolvedContentType = contentType ?? void 0;
	let resolvedFilename = filename ?? void 0;
	if (mediaBuffer) {
		assertMediaWithinLimit(mediaBuffer.byteLength, maxBytes);
		buffer = mediaBuffer;
		if (!resolvedContentType) {
			const hint = mediaPath ?? mediaUrl;
			resolvedContentType = await core.media.detectMime({
				buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
				filePath: hint
			}) ?? void 0;
		}
		if (!resolvedFilename) {resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);}
	} else {
		const source = mediaPath ?? mediaUrl;
		if (!source) {throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");}
		if (HTTP_URL_RE.test(source)) {
			const fetched = await core.channel.media.fetchRemoteMedia({
				url: source,
				maxBytes: typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : void 0
			});
			buffer = fetched.buffer;
			resolvedContentType = resolvedContentType ?? fetched.contentType ?? void 0;
			resolvedFilename = resolvedFilename ?? fetched.fileName;
		} else {
			const localFile = await assertLocalMediaPathAllowed({
				localPath: expandHomePath(resolveLocalMediaPath(source)),
				localRoots: mediaLocalRoots,
				accountId
			});
			if (typeof maxBytes === "number" && maxBytes > 0) {assertMediaWithinLimit(localFile.sizeBytes, maxBytes);}
			const data = localFile.data;
			assertMediaWithinLimit(data.byteLength, maxBytes);
			buffer = new Uint8Array(data);
			if (!resolvedContentType) {resolvedContentType = await core.media.detectMime({
				buffer: data,
				filePath: localFile.realPath
			}) ?? void 0;}
			if (!resolvedFilename) {resolvedFilename = resolveFilenameFromSource(localFile.realPath);}
		}
	}
	const replyToMessageGuid = replyToId?.trim() ? resolveBlueBubblesMessageId(replyToId.trim(), { requireKnownShortId: true }) : void 0;
	const attachmentResult = await sendBlueBubblesAttachment({
		to,
		buffer,
		filename: resolvedFilename ?? "attachment",
		contentType: resolvedContentType ?? void 0,
		replyToMessageGuid,
		asVoice,
		opts: {
			cfg,
			accountId
		}
	});
	const trimmedCaption = caption?.trim();
	if (trimmedCaption) {await sendMessageBlueBubbles(to, trimmedCaption, {
		cfg,
		accountId,
		replyToMessageGuid
	});}
	return attachmentResult;
}
//#endregion
//#region extensions/bluebubbles/src/monitor-reply-cache.ts
const REPLY_CACHE_MAX = 2e3;
const REPLY_CACHE_TTL_MS = 360 * 60 * 1e3;
const blueBubblesReplyCacheByMessageId = /* @__PURE__ */ new Map();
const blueBubblesShortIdToUuid = /* @__PURE__ */ new Map();
const blueBubblesUuidToShortId = /* @__PURE__ */ new Map();
let blueBubblesShortIdCounter = 0;
function trimOrUndefined$2(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function generateShortId() {
	blueBubblesShortIdCounter += 1;
	return String(blueBubblesShortIdCounter);
}
function rememberBlueBubblesReplyCache(entry) {
	const messageId = entry.messageId.trim();
	if (!messageId) {return {
		...entry,
		shortId: ""
	};}
	let shortId = blueBubblesUuidToShortId.get(messageId);
	if (!shortId) {
		shortId = generateShortId();
		blueBubblesShortIdToUuid.set(shortId, messageId);
		blueBubblesUuidToShortId.set(messageId, shortId);
	}
	const fullEntry = {
		...entry,
		messageId,
		shortId
	};
	blueBubblesReplyCacheByMessageId.delete(messageId);
	blueBubblesReplyCacheByMessageId.set(messageId, fullEntry);
	const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
	for (const [key, value] of blueBubblesReplyCacheByMessageId) {
		if (value.timestamp < cutoff) {
			blueBubblesReplyCacheByMessageId.delete(key);
			if (value.shortId) {
				blueBubblesShortIdToUuid.delete(value.shortId);
				blueBubblesUuidToShortId.delete(key);
			}
			continue;
		}
		break;
	}
	while (blueBubblesReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
		const oldest = blueBubblesReplyCacheByMessageId.keys().next().value;
		if (!oldest) {break;}
		const oldEntry = blueBubblesReplyCacheByMessageId.get(oldest);
		blueBubblesReplyCacheByMessageId.delete(oldest);
		if (oldEntry?.shortId) {
			blueBubblesShortIdToUuid.delete(oldEntry.shortId);
			blueBubblesUuidToShortId.delete(oldest);
		}
	}
	return fullEntry;
}
/**
* Resolves a short message ID (e.g., "1", "2") to a full BlueBubbles GUID.
* Returns the input unchanged if it's already a GUID or not found in the mapping.
*/
function resolveBlueBubblesMessageId(shortOrUuid, opts) {
	const trimmed = shortOrUuid.trim();
	if (!trimmed) {return trimmed;}
	if (/^\d+$/.test(trimmed)) {
		const uuid = blueBubblesShortIdToUuid.get(trimmed);
		if (uuid) {return uuid;}
		if (opts?.requireKnownShortId) {throw new Error(`BlueBubbles short message id "${trimmed}" is no longer available. Use MessageSidFull.`);}
	}
	return trimmed;
}
/**
* Gets the short ID for a message GUID, if one exists.
*/
function getShortIdForUuid(uuid) {
	return blueBubblesUuidToShortId.get(uuid.trim());
}
function resolveReplyContextFromCache(params) {
	const replyToId = params.replyToId.trim();
	if (!replyToId) {return null;}
	const cached = blueBubblesReplyCacheByMessageId.get(replyToId);
	if (!cached) {return null;}
	if (cached.accountId !== params.accountId) {return null;}
	const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
	if (cached.timestamp < cutoff) {
		blueBubblesReplyCacheByMessageId.delete(replyToId);
		return null;
	}
	const chatGuid = trimOrUndefined$2(params.chatGuid);
	const chatIdentifier = trimOrUndefined$2(params.chatIdentifier);
	const cachedChatGuid = trimOrUndefined$2(cached.chatGuid);
	const cachedChatIdentifier = trimOrUndefined$2(cached.chatIdentifier);
	const chatId = typeof params.chatId === "number" ? params.chatId : void 0;
	const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : void 0;
	if (chatGuid && cachedChatGuid && chatGuid !== cachedChatGuid) {return null;}
	if (!chatGuid && chatIdentifier && cachedChatIdentifier && chatIdentifier !== cachedChatIdentifier) {return null;}
	if (!chatGuid && !chatIdentifier && chatId && cachedChatId && chatId !== cachedChatId) {return null;}
	return cached;
}
//#endregion
//#region extensions/bluebubbles/src/monitor-self-chat-cache.ts
const SELF_CHAT_TTL_MS = 1e4;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1e3;
const MAX_SELF_CHAT_BODY_CHARS = 32768;
const cache = /* @__PURE__ */ new Map();
let lastCleanupAt = 0;
function normalizeBody(body) {
	if (!body) {return null;}
	const normalized = (body.length > MAX_SELF_CHAT_BODY_CHARS ? body.slice(0, MAX_SELF_CHAT_BODY_CHARS) : body).replace(/\r\n?/g, "\n").trim();
	return normalized ? normalized : null;
}
function isUsableTimestamp(timestamp) {
	return typeof timestamp === "number" && Number.isFinite(timestamp);
}
function digestText(text) {
	return createHash("sha256").update(text).digest("base64url");
}
function trimOrUndefined$1(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function resolveCanonicalChatTarget(parts) {
	const handleFromGuid = parts.chatGuid ? extractHandleFromChatGuid(parts.chatGuid) : null;
	if (handleFromGuid) {return handleFromGuid;}
	const normalizedIdentifier = normalizeBlueBubblesHandle(parts.chatIdentifier ?? "");
	if (normalizedIdentifier) {return normalizedIdentifier;}
	return trimOrUndefined$1(parts.chatGuid) ?? trimOrUndefined$1(parts.chatIdentifier) ?? (typeof parts.chatId === "number" ? String(parts.chatId) : null);
}
function buildScope(parts) {
	const target = resolveCanonicalChatTarget(parts) ?? parts.senderId;
	return `${parts.accountId}:${target}`;
}
function cleanupExpired(now = Date.now()) {
	if (lastCleanupAt !== 0 && now >= lastCleanupAt && now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {return;}
	lastCleanupAt = now;
	for (const [key, seenAt] of cache.entries()) {if (now - seenAt > SELF_CHAT_TTL_MS) cache.delete(key);}
}
function enforceSizeCap() {
	while (cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (typeof oldestKey !== "string") {break;}
		cache.delete(oldestKey);
	}
}
function buildKey(lookup) {
	const body = normalizeBody(lookup.body);
	if (!body || !isUsableTimestamp(lookup.timestamp)) {return null;}
	return `${buildScope(lookup)}:${lookup.timestamp}:${digestText(body)}`;
}
function rememberBlueBubblesSelfChatCopy(lookup) {
	cleanupExpired();
	const key = buildKey(lookup);
	if (!key) {return;}
	cache.set(key, Date.now());
	enforceSizeCap();
}
function hasBlueBubblesSelfChatCopy(lookup) {
	cleanupExpired();
	const key = buildKey(lookup);
	if (!key) {return false;}
	const seenAt = cache.get(key);
	return typeof seenAt === "number" && Date.now() - seenAt <= SELF_CHAT_TTL_MS;
}
//#endregion
//#region extensions/bluebubbles/src/reactions.ts
const REACTION_TYPES = new Set([
	"love",
	"like",
	"dislike",
	"laugh",
	"emphasize",
	"question"
]);
const REACTION_ALIASES = new Map([
	["heart", "love"],
	["love", "love"],
	["❤", "love"],
	["❤️", "love"],
	["red_heart", "love"],
	["thumbs_up", "like"],
	["thumbsup", "like"],
	["thumbs-up", "like"],
	["thumbsup", "like"],
	["like", "like"],
	["thumb", "like"],
	["ok", "like"],
	["thumbs_down", "dislike"],
	["thumbsdown", "dislike"],
	["thumbs-down", "dislike"],
	["dislike", "dislike"],
	["boo", "dislike"],
	["no", "dislike"],
	["haha", "laugh"],
	["lol", "laugh"],
	["lmao", "laugh"],
	["rofl", "laugh"],
	["😂", "laugh"],
	["🤣", "laugh"],
	["xd", "laugh"],
	["laugh", "laugh"],
	["emphasis", "emphasize"],
	["emphasize", "emphasize"],
	["exclaim", "emphasize"],
	["!!", "emphasize"],
	["‼", "emphasize"],
	["‼️", "emphasize"],
	["❗", "emphasize"],
	["important", "emphasize"],
	["bang", "emphasize"],
	["question", "question"],
	["?", "question"],
	["❓", "question"],
	["❔", "question"],
	["ask", "question"],
	["loved", "love"],
	["liked", "like"],
	["disliked", "dislike"],
	["laughed", "laugh"],
	["emphasized", "emphasize"],
	["questioned", "question"],
	["fire", "love"],
	["🔥", "love"],
	["wow", "emphasize"],
	["!", "emphasize"],
	["heart_eyes", "love"],
	["smile", "laugh"],
	["smiley", "laugh"],
	["happy", "laugh"],
	["joy", "laugh"]
]);
const REACTION_EMOJIS = new Map([
	["❤️", "love"],
	["❤", "love"],
	["♥️", "love"],
	["♥", "love"],
	["😍", "love"],
	["💕", "love"],
	["👍", "like"],
	["👌", "like"],
	["👎", "dislike"],
	["🙅", "dislike"],
	["😂", "laugh"],
	["🤣", "laugh"],
	["😆", "laugh"],
	["😁", "laugh"],
	["😹", "laugh"],
	["‼️", "emphasize"],
	["‼", "emphasize"],
	["!!", "emphasize"],
	["❗", "emphasize"],
	["❕", "emphasize"],
	["!", "emphasize"],
	["❓", "question"],
	["❔", "question"],
	["?", "question"]
]);
function resolveAccount(params) {
	return resolveBlueBubblesServerAccount(params);
}
function normalizeBlueBubblesReactionInput(emoji, remove) {
	const trimmed = emoji.trim();
	if (!trimmed) {throw new Error("BlueBubbles reaction requires an emoji or name.");}
	let raw = trimmed.toLowerCase();
	if (raw.startsWith("-")) {raw = raw.slice(1);}
	const aliased = REACTION_ALIASES.get(raw) ?? raw;
	const mapped = REACTION_EMOJIS.get(trimmed) ?? REACTION_EMOJIS.get(raw) ?? aliased;
	if (!REACTION_TYPES.has(mapped)) {throw new Error(`Unsupported BlueBubbles reaction: ${trimmed}`);}
	return remove ? `-${mapped}` : mapped;
}
async function sendBlueBubblesReaction(params) {
	const chatGuid = params.chatGuid.trim();
	const messageGuid = params.messageGuid.trim();
	if (!chatGuid) {throw new Error("BlueBubbles reaction requires chatGuid.");}
	if (!messageGuid) {throw new Error("BlueBubbles reaction requires messageGuid.");}
	const reaction = normalizeBlueBubblesReactionInput(params.emoji, params.remove);
	const { baseUrl, password, accountId } = resolveAccount(params.opts ?? {});
	if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {throw new Error("BlueBubbles reaction requires Private API, but it is disabled on the BlueBubbles server.");}
	const url = buildBlueBubblesApiUrl({
		baseUrl,
		path: "/api/v1/message/react",
		password
	});
	const payload = {
		chatGuid,
		selectedMessageGuid: messageGuid,
		reaction,
		partIndex: typeof params.partIndex === "number" ? params.partIndex : 0
	};
	const res = await blueBubblesFetchWithTimeout(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload)
	}, params.opts?.timeoutMs);
	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`BlueBubbles reaction failed (${res.status}): ${errorText || "unknown"}`);
	}
}
//#endregion
//#region extensions/bluebubbles/src/monitor-processing.ts
const DEFAULT_TEXT_LIMIT = 4e3;
const invalidAckReactions = /* @__PURE__ */ new Set();
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const PENDING_OUTBOUND_MESSAGE_ID_TTL_MS = 120 * 1e3;
const pendingOutboundMessageIds = [];
let pendingOutboundMessageIdCounter = 0;
function trimOrUndefined(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function normalizeSnippet(value) {
	return stripMarkdown(value).replace(/\s+/g, " ").trim().toLowerCase();
}
function isBlueBubblesSelfChatMessage(message, isGroup) {
	if (isGroup || !message.senderIdExplicit) {return false;}
	const chatHandle = (message.chatGuid ? extractHandleFromChatGuid(message.chatGuid) : null) ?? normalizeBlueBubblesHandle(message.chatIdentifier ?? "");
	return Boolean(chatHandle) && chatHandle === message.senderId;
}
function prunePendingOutboundMessageIds(now = Date.now()) {
	const cutoff = now - PENDING_OUTBOUND_MESSAGE_ID_TTL_MS;
	for (let i = pendingOutboundMessageIds.length - 1; i >= 0; i--) {if (pendingOutboundMessageIds[i].createdAt < cutoff) pendingOutboundMessageIds.splice(i, 1);}
}
function rememberPendingOutboundMessageId(entry) {
	prunePendingOutboundMessageIds();
	pendingOutboundMessageIdCounter += 1;
	const snippetRaw = entry.snippet.trim();
	const snippetNorm = normalizeSnippet(snippetRaw);
	pendingOutboundMessageIds.push({
		id: pendingOutboundMessageIdCounter,
		accountId: entry.accountId,
		sessionKey: entry.sessionKey,
		outboundTarget: entry.outboundTarget,
		chatGuid: trimOrUndefined(entry.chatGuid),
		chatIdentifier: trimOrUndefined(entry.chatIdentifier),
		chatId: typeof entry.chatId === "number" ? entry.chatId : void 0,
		snippetRaw,
		snippetNorm,
		isMediaSnippet: snippetRaw.toLowerCase().startsWith("<media:"),
		createdAt: Date.now()
	});
	return pendingOutboundMessageIdCounter;
}
function forgetPendingOutboundMessageId(id) {
	const index = pendingOutboundMessageIds.findIndex((entry) => entry.id === id);
	if (index >= 0) {pendingOutboundMessageIds.splice(index, 1);}
}
function chatsMatch(left, right) {
	const leftGuid = trimOrUndefined(left.chatGuid);
	const rightGuid = trimOrUndefined(right.chatGuid);
	if (leftGuid && rightGuid) {return leftGuid === rightGuid;}
	const leftIdentifier = trimOrUndefined(left.chatIdentifier);
	const rightIdentifier = trimOrUndefined(right.chatIdentifier);
	if (leftIdentifier && rightIdentifier) {return leftIdentifier === rightIdentifier;}
	const leftChatId = typeof left.chatId === "number" ? left.chatId : void 0;
	const rightChatId = typeof right.chatId === "number" ? right.chatId : void 0;
	if (leftChatId !== void 0 && rightChatId !== void 0) {return leftChatId === rightChatId;}
	return false;
}
function consumePendingOutboundMessageId(params) {
	prunePendingOutboundMessageIds();
	const bodyNorm = normalizeSnippet(params.body);
	const isMediaBody = params.body.trim().toLowerCase().startsWith("<media:");
	for (let i = 0; i < pendingOutboundMessageIds.length; i++) {
		const entry = pendingOutboundMessageIds[i];
		if (entry.accountId !== params.accountId) {continue;}
		if (!chatsMatch(entry, params)) {continue;}
		if (entry.snippetNorm && entry.snippetNorm === bodyNorm) {
			pendingOutboundMessageIds.splice(i, 1);
			return entry;
		}
		if (entry.isMediaSnippet && isMediaBody) {
			pendingOutboundMessageIds.splice(i, 1);
			return entry;
		}
	}
	return null;
}
function logVerbose(core, runtime, message) {
	if (core.logging.shouldLogVerbose()) {runtime.log?.(`[bluebubbles] ${message}`);}
}
function logGroupAllowlistHint(params) {
	const log = params.runtime.log ?? console.log;
	const nameHint = params.chatName ? ` (group name: ${params.chatName})` : "";
	const accountHint = params.accountId ? ` (or channels.bluebubbles.accounts.${params.accountId}.groupAllowFrom)` : "";
	if (params.entry) {
		log(`[bluebubbles] group message blocked (${params.reason}). Allow this group by adding "${params.entry}" to channels.bluebubbles.groupAllowFrom${nameHint}.`);
		log(`[bluebubbles] add to config: channels.bluebubbles.groupAllowFrom=["${params.entry}"]${accountHint}.`);
		return;
	}
	log(`[bluebubbles] group message blocked (${params.reason}). Allow groups by setting channels.bluebubbles.groupPolicy="open" or adding a group id to channels.bluebubbles.groupAllowFrom${accountHint}${nameHint}.`);
}
function resolveBlueBubblesAckReaction(params) {
	const raw = resolveAckReaction(params.cfg, params.agentId).trim();
	if (!raw) {return null;}
	try {
		normalizeBlueBubblesReactionInput(raw);
		return raw;
	} catch {
		const key = raw.toLowerCase();
		if (!invalidAckReactions.has(key)) {
			invalidAckReactions.add(key);
			logVerbose(params.core, params.runtime, `ack reaction skipped (unsupported for BlueBubbles): ${raw}`);
		}
		return null;
	}
}
/**
* In-memory rolling history map keyed by account + chat identifier.
* Populated from incoming messages during the session.
* API backfill is attempted until one fetch resolves (or retries are exhausted).
*/
const chatHistories = /* @__PURE__ */ new Map();
const historyBackfills = /* @__PURE__ */ new Map();
const HISTORY_BACKFILL_BASE_DELAY_MS = 5e3;
const HISTORY_BACKFILL_MAX_DELAY_MS = 120 * 1e3;
const HISTORY_BACKFILL_MAX_ATTEMPTS = 6;
const HISTORY_BACKFILL_RETRY_WINDOW_MS = 1800 * 1e3;
const MAX_STORED_HISTORY_ENTRY_CHARS = 2e3;
const MAX_INBOUND_HISTORY_ENTRY_CHARS = 1200;
const MAX_INBOUND_HISTORY_TOTAL_CHARS = 12e3;
function buildAccountScopedHistoryKey(accountId, historyIdentifier) {
	return `${accountId}\u0000${historyIdentifier}`;
}
function historyDedupKey(entry) {
	const messageId = entry.messageId?.trim();
	if (messageId) {return `id:${messageId}`;}
	return `fallback:${entry.sender}\u0000${entry.body}\u0000${entry.timestamp ?? ""}`;
}
function truncateHistoryBody(body, maxChars) {
	const trimmed = body.trim();
	if (!trimmed) {return "";}
	if (trimmed.length <= maxChars) {return trimmed;}
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}
function mergeHistoryEntries(params) {
	if (params.limit <= 0) {return [];}
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	const appendUnique = (entry) => {
		const key = historyDedupKey(entry);
		if (seen.has(key)) {return;}
		seen.add(key);
		merged.push(entry);
	};
	for (const entry of params.apiEntries) {appendUnique(entry);}
	for (const entry of params.currentEntries) {appendUnique(entry);}
	if (merged.length <= params.limit) {return merged;}
	return merged.slice(merged.length - params.limit);
}
function pruneHistoryBackfillState() {
	for (const key of historyBackfills.keys()) {if (!chatHistories.has(key)) historyBackfills.delete(key);}
}
function markHistoryBackfillResolved(historyKey) {
	const state = historyBackfills.get(historyKey);
	if (state) {
		state.resolved = true;
		historyBackfills.set(historyKey, state);
		return;
	}
	historyBackfills.set(historyKey, {
		attempts: 0,
		firstAttemptAt: Date.now(),
		nextAttemptAt: Number.POSITIVE_INFINITY,
		resolved: true
	});
}
function planHistoryBackfillAttempt(historyKey, now) {
	const existing = historyBackfills.get(historyKey);
	if (existing?.resolved) {return null;}
	if (existing && now - existing.firstAttemptAt > HISTORY_BACKFILL_RETRY_WINDOW_MS) {
		markHistoryBackfillResolved(historyKey);
		return null;
	}
	if (existing && existing.attempts >= HISTORY_BACKFILL_MAX_ATTEMPTS) {
		markHistoryBackfillResolved(historyKey);
		return null;
	}
	if (existing && now < existing.nextAttemptAt) {return null;}
	const attempts = (existing?.attempts ?? 0) + 1;
	const state = {
		attempts,
		firstAttemptAt: existing?.firstAttemptAt ?? now,
		nextAttemptAt: now + Math.min(HISTORY_BACKFILL_BASE_DELAY_MS * 2 ** (attempts - 1), HISTORY_BACKFILL_MAX_DELAY_MS),
		resolved: false
	};
	historyBackfills.set(historyKey, state);
	return state;
}
function buildInboundHistorySnapshot(params) {
	if (params.limit <= 0 || params.entries.length === 0) {return;}
	const recent = params.entries.slice(-params.limit);
	const selected = [];
	let remainingChars = MAX_INBOUND_HISTORY_TOTAL_CHARS;
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		const body = truncateHistoryBody(entry.body, MAX_INBOUND_HISTORY_ENTRY_CHARS);
		if (!body) {continue;}
		if (selected.length > 0 && body.length > remainingChars) {break;}
		selected.push({
			sender: entry.sender,
			body,
			timestamp: entry.timestamp
		});
		remainingChars -= body.length;
		if (remainingChars <= 0) {break;}
	}
	if (selected.length === 0) {return;}
	selected.reverse();
	return selected;
}
async function processMessage(message, target) {
	const { account, config, runtime, core, statusSink } = target;
	const pairing = createScopedPairingAccess({
		core,
		channel: "bluebubbles",
		accountId: account.accountId
	});
	const privateApiEnabled = isBlueBubblesPrivateApiEnabled(account.accountId);
	const groupFlag = resolveGroupFlagFromChatGuid(message.chatGuid);
	const isGroup = typeof groupFlag === "boolean" ? groupFlag : message.isGroup;
	const text = message.text.trim();
	const attachments = message.attachments ?? [];
	const placeholder = buildMessagePlaceholder(message);
	const tapbackContext = resolveTapbackContext(message);
	const tapbackParsed = parseTapbackText({
		text,
		emojiHint: tapbackContext?.emojiHint,
		actionHint: tapbackContext?.actionHint,
		requireQuoted: !tapbackContext
	});
	const isTapbackMessage = Boolean(tapbackParsed);
	const rawBody = tapbackParsed ? tapbackParsed.action === "removed" ? `removed ${tapbackParsed.emoji} reaction` : `reacted with ${tapbackParsed.emoji}` : text || placeholder;
	const isSelfChatMessage = isBlueBubblesSelfChatMessage(message, isGroup);
	const selfChatLookup = {
		accountId: account.accountId,
		chatGuid: message.chatGuid,
		chatIdentifier: message.chatIdentifier,
		chatId: message.chatId,
		senderId: message.senderId,
		body: rawBody,
		timestamp: message.timestamp
	};
	const cacheMessageId = message.messageId?.trim();
	const confirmedOutboundCacheEntry = cacheMessageId ? resolveReplyContextFromCache({
		accountId: account.accountId,
		replyToId: cacheMessageId,
		chatGuid: message.chatGuid,
		chatIdentifier: message.chatIdentifier,
		chatId: message.chatId
	}) : null;
	let messageShortId;
	const cacheInboundMessage = () => {
		if (!cacheMessageId) {return;}
		messageShortId = rememberBlueBubblesReplyCache({
			accountId: account.accountId,
			messageId: cacheMessageId,
			chatGuid: message.chatGuid,
			chatIdentifier: message.chatIdentifier,
			chatId: message.chatId,
			senderLabel: message.fromMe ? "me" : message.senderId,
			body: rawBody,
			timestamp: message.timestamp ?? Date.now()
		}).shortId;
	};
	if (message.fromMe) {
		cacheInboundMessage();
		const confirmedAssistantOutbound = confirmedOutboundCacheEntry?.senderLabel === "me" && normalizeSnippet(confirmedOutboundCacheEntry.body ?? "") === normalizeSnippet(rawBody);
		if (isSelfChatMessage && confirmedAssistantOutbound) {rememberBlueBubblesSelfChatCopy(selfChatLookup);}
		if (cacheMessageId) {
			const pending = consumePendingOutboundMessageId({
				accountId: account.accountId,
				chatGuid: message.chatGuid,
				chatIdentifier: message.chatIdentifier,
				chatId: message.chatId,
				body: rawBody
			});
			if (pending) {
				const displayId = getShortIdForUuid(cacheMessageId) || cacheMessageId;
				const previewSource = pending.snippetRaw || rawBody;
				const preview = previewSource ? ` "${previewSource.slice(0, 12)}${previewSource.length > 12 ? "…" : ""}"` : "";
				core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
					sessionKey: pending.sessionKey,
					contextKey: `bluebubbles:outbound:${pending.outboundTarget}:${cacheMessageId}`
				});
			}
		}
		return;
	}
	if (isSelfChatMessage && hasBlueBubblesSelfChatCopy(selfChatLookup)) {
		logVerbose(core, runtime, `drop: reflected self-chat duplicate sender=${message.senderId}`);
		return;
	}
	if (!rawBody) {
		logVerbose(core, runtime, `drop: empty text sender=${message.senderId}`);
		return;
	}
	logVerbose(core, runtime, `msg sender=${message.senderId} group=${isGroup} textLen=${text.length} attachments=${attachments.length} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`);
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const groupPolicy = account.config.groupPolicy ?? "allowlist";
	const configuredAllowFrom = mapAllowFromEntries(account.config.allowFrom);
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "bluebubbles",
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	});
	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: configuredAllowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
			allowFrom,
			sender: message.senderId,
			chatId: message.chatId ?? void 0,
			chatGuid: message.chatGuid ?? void 0,
			chatIdentifier: message.chatIdentifier ?? void 0
		})
	});
	const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
	const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
	const groupAllowEntry = formatGroupAllowlistEntry({
		chatGuid: message.chatGuid,
		chatId: message.chatId ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	});
	const groupName = message.chatName?.trim() || void 0;
	if (accessDecision.decision !== "allow") {
		if (isGroup) {
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
				logVerbose(core, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=disabled",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
				logVerbose(core, runtime, "Blocked BlueBubbles group message (no allowlist)");
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=allowlist (empty allowlist)",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
				logVerbose(core, runtime, `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`);
				logVerbose(core, runtime, `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`);
				logGroupAllowlistHint({
					runtime,
					reason: "groupPolicy=allowlist (not allowlisted)",
					entry: groupAllowEntry,
					chatName: groupName,
					accountId: account.accountId
				});
				return;
			}
			return;
		}
		if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
			logVerbose(core, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
			logVerbose(core, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
			return;
		}
		if (accessDecision.decision === "pairing") {
			await issuePairingChallenge({
				channel: "bluebubbles",
				senderId: message.senderId,
				senderIdLine: `Your BlueBubbles sender id: ${message.senderId}`,
				meta: { name: message.senderName },
				upsertPairingRequest: pairing.upsertPairingRequest,
				onCreated: () => {
					runtime.log?.(`[bluebubbles] pairing request sender=${message.senderId} created=true`);
					logVerbose(core, runtime, `bluebubbles pairing request sender=${message.senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageBlueBubbles(message.senderId, text, {
						cfg: config,
						accountId: account.accountId
					});
					statusSink?.({ lastOutboundAt: Date.now() });
				},
				onReplyError: (err) => {
					logVerbose(core, runtime, `bluebubbles pairing reply failed for ${message.senderId}: ${String(err)}`);
					runtime.error?.(`[bluebubbles] pairing reply failed sender=${message.senderId}: ${String(err)}`);
				}
			});
			return;
		}
		logVerbose(core, runtime, `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`);
		logVerbose(core, runtime, `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`);
		return;
	}
	const chatId = message.chatId ?? void 0;
	const chatGuid = message.chatGuid ?? void 0;
	const chatIdentifier = message.chatIdentifier ?? void 0;
	const peerId = isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : message.senderId;
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: "bluebubbles",
		accountId: account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: peerId
		}
	});
	const messageText = text;
	const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
	const wasMentioned = isGroup ? core.channel.mentions.matchesMentionPatterns(messageText, mentionRegexes) : true;
	const canDetectMention = mentionRegexes.length > 0;
	const requireMention = core.channel.groups.resolveRequireMention({
		cfg: config,
		channel: "bluebubbles",
		groupId: peerId,
		accountId: account.accountId
	});
	const useAccessGroups = config.commands?.useAccessGroups !== false;
	const hasControlCmd = core.channel.text.hasControlCommand(messageText, config);
	const commandDmAllowFrom = isGroup ? configuredAllowFrom : effectiveAllowFrom;
	const ownerAllowedForCommands = commandDmAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
		allowFrom: commandDmAllowFrom,
		sender: message.senderId,
		chatId: message.chatId ?? void 0,
		chatGuid: message.chatGuid ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	}) : false;
	const groupAllowedForCommands = effectiveGroupAllowFrom.length > 0 ? isAllowedBlueBubblesSender({
		allowFrom: effectiveGroupAllowFrom,
		sender: message.senderId,
		chatId: message.chatId ?? void 0,
		chatGuid: message.chatGuid ?? void 0,
		chatIdentifier: message.chatIdentifier ?? void 0
	}) : false;
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: ownerAllowedForCommands
		}, {
			configured: effectiveGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands: true,
		hasControlCommand: hasControlCmd
	});
	const commandAuthorized = commandGate.commandAuthorized;
	if (isGroup && commandGate.shouldBlock) {
		logInboundDrop({
			log: (msg) => logVerbose(core, runtime, msg),
			channel: "bluebubbles",
			reason: "control command (unauthorized)",
			target: message.senderId
		});
		return;
	}
	const shouldBypassMention = isGroup && requireMention && !wasMentioned && commandAuthorized && hasControlCmd;
	const effectiveWasMentioned = wasMentioned || shouldBypassMention;
	if (isGroup && requireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
		logVerbose(core, runtime, `bluebubbles: skipping group message (no mention)`);
		return;
	}
	cacheInboundMessage();
	const baseUrl = normalizeSecretInputString(account.config.serverUrl);
	const password = normalizeSecretInputString(account.config.password);
	const maxBytes = account.config.mediaMaxMb && account.config.mediaMaxMb > 0 ? account.config.mediaMaxMb * 1024 * 1024 : 8 * 1024 * 1024;
	let mediaUrls = [];
	let mediaPaths = [];
	let mediaTypes = [];
	if (attachments.length > 0) {if (!baseUrl || !password) logVerbose(core, runtime, "attachment download skipped (missing serverUrl/password)");
	else for (const attachment of attachments) {
		if (!attachment.guid) continue;
		if (attachment.totalBytes && attachment.totalBytes > maxBytes) {
			logVerbose(core, runtime, `attachment too large guid=${attachment.guid} bytes=${attachment.totalBytes}`);
			continue;
		}
		try {
			const downloaded = await downloadBlueBubblesAttachment(attachment, {
				cfg: config,
				accountId: account.accountId,
				maxBytes
			});
			const saved = await core.channel.media.saveMediaBuffer(Buffer.from(downloaded.buffer), downloaded.contentType, "inbound", maxBytes);
			mediaPaths.push(saved.path);
			mediaUrls.push(saved.path);
			if (saved.contentType) mediaTypes.push(saved.contentType);
		} catch (err) {
			logVerbose(core, runtime, `attachment download failed guid=${attachment.guid} err=${String(err)}`);
		}
	}}
	let replyToId = message.replyToId;
	let replyToBody = message.replyToBody;
	let replyToSender = message.replyToSender;
	let replyToShortId;
	if (isTapbackMessage && tapbackContext?.replyToId) {replyToId = tapbackContext.replyToId;}
	if (replyToId) {
		const cached = resolveReplyContextFromCache({
			accountId: account.accountId,
			replyToId,
			chatGuid: message.chatGuid,
			chatIdentifier: message.chatIdentifier,
			chatId: message.chatId
		});
		if (cached) {
			if (!replyToBody && cached.body) {replyToBody = cached.body;}
			if (!replyToSender && cached.senderLabel) {replyToSender = cached.senderLabel;}
			replyToShortId = cached.shortId;
			if (core.logging.shouldLogVerbose()) {
				const preview = (cached.body ?? "").replace(/\s+/g, " ").slice(0, 120);
				logVerbose(core, runtime, `reply-context cache hit replyToId=${replyToId} sender=${replyToSender ?? ""} body="${preview}"`);
			}
		}
	}
	if (replyToId && !replyToShortId) {replyToShortId = getShortIdForUuid(replyToId);}
	const replyTag = formatReplyTag({
		replyToId,
		replyToShortId
	});
	const baseBody = replyTag ? isTapbackMessage ? `${rawBody} ${replyTag}` : `${replyTag} ${rawBody}` : rawBody;
	const senderLabel = message.senderName || `user:${message.senderId}`;
	const fromLabel = isGroup ? `${message.chatName?.trim() || "Group"} id:${peerId}` : senderLabel !== message.senderId ? `${senderLabel} id:${message.senderId}` : senderLabel;
	const groupSubject = isGroup ? message.chatName?.trim() || void 0 : void 0;
	const groupMembers = isGroup ? formatGroupMembers({
		participants: message.participants,
		fallback: message.senderId ? {
			id: message.senderId,
			name: message.senderName
		} : void 0
	}) : void 0;
	const storePath = core.channel.session.resolveStorePath(config.session?.store, { agentId: route.agentId });
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
	const previousTimestamp = core.channel.session.readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = core.channel.reply.formatInboundEnvelope({
		channel: "BlueBubbles",
		from: fromLabel,
		timestamp: message.timestamp,
		previousTimestamp,
		envelope: envelopeOptions,
		body: baseBody,
		chatType: isGroup ? "group" : "direct",
		sender: {
			name: message.senderName || void 0,
			id: message.senderId
		}
	});
	let chatGuidForActions = chatGuid;
	if (!chatGuidForActions && baseUrl && password) {
		const resolveTarget = isGroup && (chatId || chatIdentifier) ? chatId ? {
			kind: "chat_id",
			chatId
		} : {
			kind: "chat_identifier",
			chatIdentifier: chatIdentifier ?? ""
		} : {
			kind: "handle",
			address: message.senderId
		};
		if (resolveTarget.kind !== "chat_identifier" || resolveTarget.chatIdentifier) {chatGuidForActions = await resolveChatGuidForTarget({
			baseUrl,
			password,
			target: resolveTarget
		}) ?? void 0;}
	}
	const ackReactionScope = config.messages?.ackReactionScope ?? "group-mentions";
	const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;
	const ackReactionValue = resolveBlueBubblesAckReaction({
		cfg: config,
		agentId: route.agentId,
		core,
		runtime
	});
	const shouldAckReaction = () => Boolean(ackReactionValue && core.channel.reactions.shouldAckReaction({
		scope: ackReactionScope,
		isDirect: !isGroup,
		isGroup,
		isMentionableGroup: isGroup,
		requireMention: Boolean(requireMention),
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention
	}));
	const ackMessageId = message.messageId?.trim() || "";
	const ackReactionPromise = shouldAckReaction() && ackMessageId && chatGuidForActions && ackReactionValue ? sendBlueBubblesReaction({
		chatGuid: chatGuidForActions,
		messageGuid: ackMessageId,
		emoji: ackReactionValue,
		opts: {
			cfg: config,
			accountId: account.accountId
		}
	}).then(() => true, (err) => {
		logVerbose(core, runtime, `ack reaction failed chatGuid=${chatGuidForActions} msg=${ackMessageId}: ${String(err)}`);
		return false;
	}) : null;
	const sendReadReceipts = account.config.sendReadReceipts !== false;
	if (chatGuidForActions && baseUrl && password && sendReadReceipts) {try {
		await markBlueBubblesChatRead(chatGuidForActions, {
			cfg: config,
			accountId: account.accountId
		});
		logVerbose(core, runtime, `marked read chatGuid=${chatGuidForActions}`);
	} catch (err) {
		runtime.error?.(`[bluebubbles] mark read failed: ${String(err)}`);
	}}
	else if (!sendReadReceipts) {logVerbose(core, runtime, "mark read skipped (sendReadReceipts=false)");}
	else {logVerbose(core, runtime, "mark read skipped (missing chatGuid or credentials)");}
	const outboundTarget = isGroup ? formatBlueBubblesChatTarget({
		chatId,
		chatGuid: chatGuidForActions ?? chatGuid,
		chatIdentifier
	}) || peerId : chatGuidForActions ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions }) : message.senderId;
	const maybeEnqueueOutboundMessageId = (messageId, snippet) => {
		const trimmed = messageId?.trim();
		if (!trimmed || trimmed === "ok" || trimmed === "unknown") {return false;}
		const displayId = rememberBlueBubblesReplyCache({
			accountId: account.accountId,
			messageId: trimmed,
			chatGuid: chatGuidForActions ?? chatGuid,
			chatIdentifier,
			chatId,
			senderLabel: "me",
			body: snippet ?? "",
			timestamp: Date.now()
		}).shortId || trimmed;
		const preview = snippet ? ` "${snippet.slice(0, 12)}${snippet.length > 12 ? "…" : ""}"` : "";
		core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
			sessionKey: route.sessionKey,
			contextKey: `bluebubbles:outbound:${outboundTarget}:${trimmed}`
		});
		return true;
	};
	const sanitizeReplyDirectiveText = (value) => {
		if (privateApiEnabled) {return value;}
		return value.replace(REPLY_DIRECTIVE_TAG_RE, " ").replace(/[ \t]+/g, " ").trim();
	};
	const historyLimit = isGroup ? account.config.historyLimit ?? 0 : account.config.dmHistoryLimit ?? 0;
	const historyIdentifier = chatGuid || chatIdentifier || (chatId ? String(chatId) : null) || (isGroup ? null : message.senderId) || "";
	const historyKey = historyIdentifier ? buildAccountScopedHistoryKey(account.accountId, historyIdentifier) : "";
	if (historyKey && historyLimit > 0) {
		const nowMs = Date.now();
		const senderLabel = message.fromMe ? "me" : message.senderName || message.senderId;
		const normalizedHistoryBody = truncateHistoryBody(text, MAX_STORED_HISTORY_ENTRY_CHARS);
		const currentEntries = recordPendingHistoryEntryIfEnabled({
			historyMap: chatHistories,
			limit: historyLimit,
			historyKey,
			entry: normalizedHistoryBody ? {
				sender: senderLabel,
				body: normalizedHistoryBody,
				timestamp: message.timestamp ?? nowMs,
				messageId: message.messageId ?? void 0
			} : null
		});
		pruneHistoryBackfillState();
		const backfillAttempt = planHistoryBackfillAttempt(historyKey, nowMs);
		if (backfillAttempt) {try {
			const backfillResult = await fetchBlueBubblesHistory(historyIdentifier, historyLimit, {
				cfg: config,
				accountId: account.accountId
			});
			if (backfillResult.resolved) markHistoryBackfillResolved(historyKey);
			if (backfillResult.entries.length > 0) {
				const apiEntries = [];
				for (const entry of backfillResult.entries) {
					const body = truncateHistoryBody(entry.body, MAX_STORED_HISTORY_ENTRY_CHARS);
					if (!body) continue;
					apiEntries.push({
						sender: entry.sender,
						body,
						timestamp: entry.timestamp,
						messageId: entry.messageId
					});
				}
				const merged = mergeHistoryEntries({
					apiEntries,
					currentEntries: currentEntries.length > 0 ? currentEntries : chatHistories.get(historyKey) ?? [],
					limit: historyLimit
				});
				if (chatHistories.has(historyKey)) chatHistories.delete(historyKey);
				chatHistories.set(historyKey, merged);
				evictOldHistoryKeys(chatHistories);
				logVerbose(core, runtime, `backfilled ${backfillResult.entries.length} history messages for ${isGroup ? "group" : "DM"}: ${historyIdentifier}`);
			} else if (!backfillResult.resolved) {
				const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
				const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
				logVerbose(core, runtime, `history backfill unresolved for ${historyIdentifier}; retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs}`);
			}
		} catch (err) {
			const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
			const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
			logVerbose(core, runtime, `history backfill failed for ${historyIdentifier}: ${String(err)} (retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs})`);
		}}
	}
	let inboundHistory;
	if (historyKey && historyLimit > 0) {
		const entries = chatHistories.get(historyKey);
		if (entries && entries.length > 0) {inboundHistory = buildInboundHistorySnapshot({
			entries,
			limit: historyLimit
		});}
	}
	const commandBody = messageText.trim();
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		BodyForCommands: commandBody,
		MediaUrl: mediaUrls[0],
		MediaUrls: mediaUrls.length > 0 ? mediaUrls : void 0,
		MediaPath: mediaPaths[0],
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : void 0,
		MediaType: mediaTypes[0],
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : void 0,
		From: isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
		To: `bluebubbles:${outboundTarget}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: fromLabel,
		ReplyToId: replyToShortId || replyToId,
		ReplyToIdFull: replyToId,
		ReplyToBody: replyToBody,
		ReplyToSender: replyToSender,
		GroupSubject: groupSubject,
		GroupMembers: groupMembers,
		SenderName: message.senderName || void 0,
		SenderId: message.senderId,
		Provider: "bluebubbles",
		Surface: "bluebubbles",
		MessageSid: messageShortId || message.messageId,
		MessageSidFull: message.messageId,
		Timestamp: message.timestamp,
		OriginatingChannel: "bluebubbles",
		OriginatingTo: `bluebubbles:${outboundTarget}`,
		WasMentioned: effectiveWasMentioned,
		CommandAuthorized: commandAuthorized
	});
	let sentMessage = false;
	let streamingActive = false;
	let typingRestartTimer;
	const typingRestartDelayMs = 150;
	const clearTypingRestartTimer = () => {
		if (typingRestartTimer) {
			clearTimeout(typingRestartTimer);
			typingRestartTimer = void 0;
		}
	};
	const restartTypingSoon = () => {
		if (!streamingActive || !chatGuidForActions || !baseUrl || !password) {return;}
		clearTypingRestartTimer();
		typingRestartTimer = setTimeout(() => {
			typingRestartTimer = void 0;
			if (!streamingActive) {return;}
			sendBlueBubblesTyping(chatGuidForActions, true, {
				cfg: config,
				accountId: account.accountId
			}).catch((err) => {
				runtime.error?.(`[bluebubbles] typing restart failed: ${String(err)}`);
			});
		}, typingRestartDelayMs);
	};
	try {
		const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
			cfg: config,
			agentId: route.agentId,
			channel: "bluebubbles",
			accountId: account.accountId
		});
		await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg: config,
			dispatcherOptions: {
				...prefixOptions,
				deliver: async (payload, info) => {
					const rawReplyToId = privateApiEnabled && typeof payload.replyToId === "string" ? payload.replyToId.trim() : "";
					const replyToMessageGuid = rawReplyToId ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true }) : "";
					const mediaList = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
					if (mediaList.length > 0) {
						const tableMode = core.channel.text.resolveMarkdownTableMode({
							cfg: config,
							channel: "bluebubbles",
							accountId: account.accountId
						});
						const text = sanitizeReplyDirectiveText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
						let first = true;
						for (const mediaUrl of mediaList) {
							const caption = first ? text : void 0;
							first = false;
							const cachedBody = (caption ?? "").trim() || "<media:attachment>";
							const pendingId = rememberPendingOutboundMessageId({
								accountId: account.accountId,
								sessionKey: route.sessionKey,
								outboundTarget,
								chatGuid: chatGuidForActions ?? chatGuid,
								chatIdentifier,
								chatId,
								snippet: cachedBody
							});
							let result;
							try {
								result = await sendBlueBubblesMedia({
									cfg: config,
									to: outboundTarget,
									mediaUrl,
									caption: caption ?? void 0,
									replyToId: replyToMessageGuid || null,
									accountId: account.accountId
								});
							} catch (err) {
								forgetPendingOutboundMessageId(pendingId);
								throw err;
							}
							if (maybeEnqueueOutboundMessageId(result.messageId, cachedBody)) {forgetPendingOutboundMessageId(pendingId);}
							sentMessage = true;
							statusSink?.({ lastOutboundAt: Date.now() });
							if (info.kind === "block") {restartTypingSoon();}
						}
						return;
					}
					const textLimit = account.config.textChunkLimit && account.config.textChunkLimit > 0 ? account.config.textChunkLimit : DEFAULT_TEXT_LIMIT;
					const chunkMode = account.config.chunkMode ?? "length";
					const tableMode = core.channel.text.resolveMarkdownTableMode({
						cfg: config,
						channel: "bluebubbles",
						accountId: account.accountId
					});
					const text = sanitizeReplyDirectiveText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
					const chunks = chunkMode === "newline" ? core.channel.text.chunkTextWithMode(text, textLimit, chunkMode) : core.channel.text.chunkMarkdownText(text, textLimit);
					if (!chunks.length && text) {chunks.push(text);}
					if (!chunks.length) {return;}
					for (const chunk of chunks) {
						const pendingId = rememberPendingOutboundMessageId({
							accountId: account.accountId,
							sessionKey: route.sessionKey,
							outboundTarget,
							chatGuid: chatGuidForActions ?? chatGuid,
							chatIdentifier,
							chatId,
							snippet: chunk
						});
						let result;
						try {
							result = await sendMessageBlueBubbles(outboundTarget, chunk, {
								cfg: config,
								accountId: account.accountId,
								replyToMessageGuid: replyToMessageGuid || void 0
							});
						} catch (err) {
							forgetPendingOutboundMessageId(pendingId);
							throw err;
						}
						if (maybeEnqueueOutboundMessageId(result.messageId, chunk)) {forgetPendingOutboundMessageId(pendingId);}
						sentMessage = true;
						statusSink?.({ lastOutboundAt: Date.now() });
						if (info.kind === "block") {restartTypingSoon();}
					}
				},
				onReplyStart: async () => {
					if (!chatGuidForActions) {return;}
					if (!baseUrl || !password) {return;}
					streamingActive = true;
					clearTypingRestartTimer();
					try {
						await sendBlueBubblesTyping(chatGuidForActions, true, {
							cfg: config,
							accountId: account.accountId
						});
					} catch (err) {
						runtime.error?.(`[bluebubbles] typing start failed: ${String(err)}`);
					}
				},
				onIdle: async () => {
					if (!chatGuidForActions) {return;}
					if (!baseUrl || !password) {return;}
				},
				onError: (err, info) => {
					runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${String(err)}`);
				}
			},
			replyOptions: {
				onModelSelected,
				disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
			}
		});
	} finally {
		const shouldStopTyping = Boolean(chatGuidForActions && baseUrl && password) && (streamingActive || !sentMessage);
		streamingActive = false;
		clearTypingRestartTimer();
		if (sentMessage && chatGuidForActions && ackMessageId) {core.channel.reactions.removeAckReactionAfterReply({
			removeAfterReply: removeAckAfterReply,
			ackReactionPromise,
			ackReactionValue: ackReactionValue ?? null,
			remove: () => sendBlueBubblesReaction({
				chatGuid: chatGuidForActions,
				messageGuid: ackMessageId,
				emoji: ackReactionValue ?? "",
				remove: true,
				opts: {
					cfg: config,
					accountId: account.accountId
				}
			}),
			onError: (err) => {
				logAckFailure({
					log: (msg) => logVerbose(core, runtime, msg),
					channel: "bluebubbles",
					target: `${chatGuidForActions}/${ackMessageId}`,
					error: err
				});
			}
		});}
		if (shouldStopTyping && chatGuidForActions) {sendBlueBubblesTyping(chatGuidForActions, false, {
			cfg: config,
			accountId: account.accountId
		}).catch((err) => {
			logTypingFailure({
				log: (msg) => logVerbose(core, runtime, msg),
				channel: "bluebubbles",
				action: "stop",
				target: chatGuidForActions,
				error: err
			});
		});}
	}
}
async function processReaction(reaction, target) {
	const { account, config, runtime, core } = target;
	const pairing = createScopedPairingAccess({
		core,
		channel: "bluebubbles",
		accountId: account.accountId
	});
	if (reaction.fromMe) {return;}
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const groupPolicy = account.config.groupPolicy ?? "allowlist";
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "bluebubbles",
		accountId: account.accountId,
		dmPolicy,
		readStore: pairing.readStoreForDmPolicy
	});
	if (resolveDmGroupAccessWithLists({
		isGroup: reaction.isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: account.config.allowFrom,
		groupAllowFrom: account.config.groupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowFrom) => isAllowedBlueBubblesSender({
			allowFrom,
			sender: reaction.senderId,
			chatId: reaction.chatId ?? void 0,
			chatGuid: reaction.chatGuid ?? void 0,
			chatIdentifier: reaction.chatIdentifier ?? void 0
		})
	}).decision !== "allow") {return;}
	const chatId = reaction.chatId ?? void 0;
	const chatGuid = reaction.chatGuid ?? void 0;
	const chatIdentifier = reaction.chatIdentifier ?? void 0;
	const peerId = reaction.isGroup ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group") : reaction.senderId;
	const route = core.channel.routing.resolveAgentRoute({
		cfg: config,
		channel: "bluebubbles",
		accountId: account.accountId,
		peer: {
			kind: reaction.isGroup ? "group" : "direct",
			id: peerId
		}
	});
	const senderLabel = reaction.senderName || reaction.senderId;
	const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
	const messageDisplayId = getShortIdForUuid(reaction.messageId) || reaction.messageId;
	const text = reaction.action === "removed" ? `${senderLabel} removed ${reaction.emoji} reaction [[reply_to:${messageDisplayId}]]${chatLabel}` : `${senderLabel} reacted with ${reaction.emoji} [[reply_to:${messageDisplayId}]]${chatLabel}`;
	core.system.enqueueSystemEvent(text, {
		sessionKey: route.sessionKey,
		contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`
	});
	logVerbose(core, runtime, `reaction event enqueued: ${text}`);
}
//#endregion
//#region extensions/bluebubbles/src/monitor.ts
const webhookTargets = /* @__PURE__ */ new Map();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const debounceRegistry = createBlueBubblesDebounceRegistry({ processMessage });
function registerBlueBubblesWebhookTarget(target) {
	const registered = registerWebhookTargetWithPluginRoute({
		targetsByPath: webhookTargets,
		target,
		route: {
			auth: "plugin",
			match: "exact",
			pluginId: "bluebubbles",
			source: "bluebubbles-webhook",
			accountId: target.account.accountId,
			log: target.runtime.log,
			handler: async (req, res) => {
				if (!await handleBlueBubblesWebhookRequest(req, res) && !res.headersSent) {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Not Found");
				}
			}
		}
	});
	return () => {
		registered.unregister();
		debounceRegistry.removeDebouncer(registered.target);
	};
}
function parseBlueBubblesWebhookPayload(rawBody) {
	const trimmed = rawBody.trim();
	if (!trimmed) {return {
		ok: false,
		error: "empty payload"
	};}
	try {
		return {
			ok: true,
			value: JSON.parse(trimmed)
		};
	} catch {
		const params = new URLSearchParams(rawBody);
		const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
		if (!payload) {return {
			ok: false,
			error: "invalid json"
		};}
		try {
			return {
				ok: true,
				value: JSON.parse(payload)
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function maskSecret(value) {
	if (value.length <= 6) {return "***";}
	return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
function normalizeAuthToken(raw) {
	const value = raw.trim();
	if (!value) {return "";}
	if (value.toLowerCase().startsWith("bearer ")) {return value.slice(7).trim();}
	return value;
}
function safeEqualSecret(aRaw, bRaw) {
	const a = normalizeAuthToken(aRaw);
	const b = normalizeAuthToken(bRaw);
	if (!a || !b) {return false;}
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) {return false;}
	return timingSafeEqual(bufA, bufB);
}
async function handleBlueBubblesWebhookRequest(req, res) {
	return await withResolvedWebhookRequestPipeline({
		req,
		res,
		targetsByPath: webhookTargets,
		allowMethods: ["POST"],
		inFlightLimiter: webhookInFlightLimiter,
		handle: async ({ path, targets }) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
			const headerToken = req.headers["x-guid"] ?? req.headers["x-password"] ?? req.headers["x-bluebubbles-guid"] ?? req.headers["authorization"];
			const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
			const target = resolveWebhookTargetWithAuthOrRejectSync({
				targets,
				res,
				isMatch: (target) => {
					return safeEqualSecret(guid, target.account.config.password?.trim() ?? "");
				}
			});
			if (!target) {
				console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode} path=${path} guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`);
				return true;
			}
			const body = await readWebhookBodyOrReject({
				req,
				res,
				profile: "post-auth",
				invalidBodyMessage: "invalid payload"
			});
			if (!body.ok) {
				console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode}`);
				return true;
			}
			const parsed = parseBlueBubblesWebhookPayload(body.value);
			if (!parsed.ok) {
				res.statusCode = 400;
				res.end(parsed.error);
				console.warn(`[bluebubbles] webhook rejected: ${parsed.error}`);
				return true;
			}
			const payload = asRecord(parsed.value) ?? {};
			const firstTarget = targets[0];
			if (firstTarget) {logVerbose(firstTarget.core, firstTarget.runtime, `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`);}
			const eventTypeRaw = payload.type;
			const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw.trim() : "";
			if (eventType && !new Set([
				"new-message",
				"updated-message",
				"message-reaction",
				"reaction"
			]).has(eventType)) {
				res.statusCode = 200;
				res.end("ok");
				if (firstTarget) {logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored type=${eventType}`);}
				return true;
			}
			const reaction = normalizeWebhookReaction(payload);
			if ((eventType === "updated-message" || eventType === "message-reaction" || eventType === "reaction") && !reaction) {
				res.statusCode = 200;
				res.end("ok");
				if (firstTarget) {logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored ${eventType || "event"} without reaction`);}
				return true;
			}
			const message = reaction ? null : normalizeWebhookMessage(payload);
			if (!message && !reaction) {
				res.statusCode = 400;
				res.end("invalid payload");
				console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
				return true;
			}
			target.statusSink?.({ lastInboundAt: Date.now() });
			if (reaction) {processReaction(reaction, target).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`);
			});}
			else if (message) {debounceRegistry.getOrCreateDebouncer(target).enqueue({
				message,
				target
			}).catch((err) => {
				target.runtime.error?.(`[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`);
			});}
			res.statusCode = 200;
			res.end("ok");
			if (reaction) {
				if (firstTarget) {logVerbose(firstTarget.core, firstTarget.runtime, `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`);}
			} else if (message) {
				if (firstTarget) {logVerbose(firstTarget.core, firstTarget.runtime, `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`);}
			}
			return true;
		}
	});
}
async function monitorBlueBubblesProvider(options) {
	const { account, config, runtime, abortSignal, statusSink } = options;
	const core = getBlueBubblesRuntime();
	const path = options.webhookPath?.trim() || "/bluebubbles-webhook";
	const serverInfo = await fetchBlueBubblesServerInfo({
		baseUrl: account.baseUrl,
		password: account.config.password,
		accountId: account.accountId,
		timeoutMs: 5e3
	}).catch(() => null);
	if (serverInfo?.os_version) {runtime.log?.(`[${account.accountId}] BlueBubbles server macOS ${serverInfo.os_version}`);}
	if (typeof serverInfo?.private_api === "boolean") {runtime.log?.(`[${account.accountId}] BlueBubbles Private API ${serverInfo.private_api ? "enabled" : "disabled"}`);}
	const unregister = registerBlueBubblesWebhookTarget({
		account,
		config,
		runtime,
		core,
		path,
		statusSink
	});
	return await new Promise((resolve) => {
		const stop = () => {
			unregister();
			resolve();
		};
		if (abortSignal?.aborted) {
			stop();
			return;
		}
		abortSignal?.addEventListener("abort", stop, { once: true });
		runtime.log?.(`[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`);
	});
}
//#endregion
export { addBlueBubblesParticipant as a, removeBlueBubblesParticipant as c, unsendBlueBubblesMessage as d, sendBlueBubblesAttachment as f, sendBlueBubblesMedia as i, renameBlueBubblesChat as l, sendMessageBlueBubbles as m, sendBlueBubblesReaction as n, editBlueBubblesMessage as o, resolveChatGuidForTarget as p, resolveBlueBubblesMessageId as r, leaveBlueBubblesChat as s, monitorBlueBubblesProvider as t, setGroupIconBlueBubbles as u };
