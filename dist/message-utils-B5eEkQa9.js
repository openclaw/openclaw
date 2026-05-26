import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, l as normalizeOptionalStringifiedId } from "./string-coerce-DyL154ka.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as getFileExtension } from "./mime-DppuT-pZ.js";
import { S as buildMediaPayload } from "./reply-payload-DMPQsrQC.js";
import { a as saveRemoteMedia } from "./fetch-C0wRQZuz.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./media-runtime-BheBFFxc.js";
import "./media-mime-j2Nhr7Df.js";
import { Gt as StickerFormatType, Lt as ComponentType } from "./discord-Cn5UmvYW.js";
import { n as resolveDiscordChannelInfoSafe } from "./channel-access-C12aDZ0p.js";
import { a as mergeAbortSignals } from "./timeouts-l_PsHQvX.js";
//#region extensions/discord/src/monitor/message-channel-info.ts
const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 300 * 1e3;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1e3;
const DISCORD_CHANNEL_INFO_CACHE = /* @__PURE__ */ new Map();
function normalizeDiscordChannelId(value) {
	return normalizeOptionalStringifiedId(value) ?? "";
}
function resolveDiscordMessageChannelId(params) {
	const message = params.message;
	return normalizeDiscordChannelId(message.channelId) || normalizeDiscordChannelId(message.channel_id) || normalizeDiscordChannelId(message.rawData?.channel_id) || normalizeDiscordChannelId(params.eventChannelId);
}
async function resolveDiscordChannelInfo(client, channelId) {
	const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
	if (cached) {
		if (cached.expiresAt > Date.now()) return cached.value;
		DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
	}
	try {
		const channel = await client.fetchChannel(channelId);
		if (!channel) {
			DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
				value: null,
				expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS
			});
			return null;
		}
		const channelInfo = resolveDiscordChannelInfoSafe(channel);
		const rawChannel = channel;
		const type = channelInfo.type ?? rawChannel.type;
		if (type === void 0) return null;
		const payload = {
			type,
			name: channelInfo.name,
			topic: channelInfo.topic,
			parentId: channelInfo.parentId,
			ownerId: channelInfo.ownerId
		};
		DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
			value: payload,
			expiresAt: Date.now() + DISCORD_CHANNEL_INFO_CACHE_TTL_MS
		});
		return payload;
	} catch (err) {
		logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
		DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
			value: null,
			expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS
		});
		return null;
	}
}
//#endregion
//#region extensions/discord/src/monitor/message-forwarded.ts
const FORWARD_MESSAGE_REFERENCE_TYPE = 1;
function normalizeDiscordStickerItems(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && typeof entry.name === "string");
}
function resolveDiscordMessageStickers(message) {
	const stickers = message.stickers;
	const normalized = normalizeDiscordStickerItems(stickers);
	if (normalized.length > 0) return normalized;
	const rawData = message.rawData;
	return normalizeDiscordStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}
function resolveDiscordSnapshotStickers(snapshot) {
	return normalizeDiscordStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}
function hasDiscordMessageStickers(message) {
	return resolveDiscordMessageStickers(message).length > 0;
}
function resolveDiscordMessageSnapshots(message) {
	const rawData = message.rawData;
	return normalizeDiscordMessageSnapshots(rawData?.message_snapshots ?? message.message_snapshots ?? message.messageSnapshots);
}
function normalizeDiscordMessageSnapshots(snapshots) {
	if (!Array.isArray(snapshots)) return [];
	return snapshots.filter((entry) => Boolean(entry) && typeof entry === "object");
}
function resolveDiscordReferencedForwardMessage(message) {
	const referenceType = message.messageReference?.type;
	return Number(referenceType) === FORWARD_MESSAGE_REFERENCE_TYPE ? message.referencedMessage : null;
}
function resolveDiscordReferencedReplyMessage(message) {
	const referenceType = message.messageReference?.type;
	return Number(referenceType) === FORWARD_MESSAGE_REFERENCE_TYPE ? null : message.referencedMessage ?? null;
}
function formatDiscordSnapshotAuthor(author) {
	if (!author) return;
	const globalName = normalizeOptionalString(author.global_name) ?? void 0;
	const username = normalizeOptionalString(author.username) ?? void 0;
	const name = normalizeOptionalString(author.name) ?? void 0;
	const discriminator = normalizeOptionalString(author.discriminator) ?? void 0;
	const base = globalName || username || name;
	if (username && discriminator && discriminator !== "0") return `@${username}#${discriminator}`;
	if (base) return `@${base}`;
	if (author.id) return `@${author.id}`;
}
//#endregion
//#region extensions/discord/src/monitor/message-media.ts
const DISCORD_MEDIA_SSRF_POLICY = {
	hostnameAllowlist: [
		"cdn.discordapp.com",
		"media.discordapp.net",
		"*.discordapp.com",
		"*.discordapp.net"
	],
	allowRfc2544BenchmarkRange: true
};
const AUDIO_ATTACHMENT_EXTENSIONS = new Set([
	".aac",
	".caf",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav"
]);
const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";
function isDiscordAudioAttachmentFileName(fileName) {
	const ext = getFileExtension(fileName);
	return Boolean(ext && AUDIO_ATTACHMENT_EXTENSIONS.has(ext));
}
function hasDiscordVoiceAttachmentFields(attachment) {
	return typeof attachment.duration_secs === "number" || typeof attachment.waveform === "string";
}
function mergeHostnameList(...lists) {
	const merged = lists.flatMap((list) => list ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
	if (merged.length === 0) return;
	return Array.from(new Set(merged));
}
function resolveDiscordMediaSsrFPolicy(policy) {
	if (!policy) return DISCORD_MEDIA_SSRF_POLICY;
	const hostnameAllowlist = mergeHostnameList(DISCORD_MEDIA_SSRF_POLICY.hostnameAllowlist, policy.hostnameAllowlist);
	const allowedHostnames = mergeHostnameList(DISCORD_MEDIA_SSRF_POLICY.allowedHostnames, policy.allowedHostnames);
	return {
		...DISCORD_MEDIA_SSRF_POLICY,
		...policy,
		...allowedHostnames ? { allowedHostnames } : {},
		...hostnameAllowlist ? { hostnameAllowlist } : {},
		allowRfc2544BenchmarkRange: Boolean(DISCORD_MEDIA_SSRF_POLICY.allowRfc2544BenchmarkRange) || Boolean(policy.allowRfc2544BenchmarkRange)
	};
}
async function resolveMediaList(message, maxBytes, options) {
	const out = [];
	const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
	await appendResolvedMediaFromAttachments({
		attachments: message.attachments ?? [],
		maxBytes,
		out,
		errorPrefix: "discord: failed to download attachment",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	await appendResolvedMediaFromStickers({
		stickers: resolveDiscordMessageStickers(message),
		maxBytes,
		out,
		errorPrefix: "discord: failed to download sticker",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	return out;
}
async function resolveForwardedMediaList(message, maxBytes, options) {
	const snapshots = resolveDiscordMessageSnapshots(message);
	const out = [];
	const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
	if (snapshots.length > 0) {
		for (const snapshot of snapshots) {
			await appendResolvedMediaFromAttachments({
				attachments: snapshot.message?.attachments,
				maxBytes,
				out,
				errorPrefix: "discord: failed to download forwarded attachment",
				fetchImpl: options?.fetchImpl,
				ssrfPolicy: resolvedSsrFPolicy,
				readIdleTimeoutMs: options?.readIdleTimeoutMs,
				totalTimeoutMs: options?.totalTimeoutMs,
				abortSignal: options?.abortSignal
			});
			await appendResolvedMediaFromStickers({
				stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
				maxBytes,
				out,
				errorPrefix: "discord: failed to download forwarded sticker",
				fetchImpl: options?.fetchImpl,
				ssrfPolicy: resolvedSsrFPolicy,
				readIdleTimeoutMs: options?.readIdleTimeoutMs,
				totalTimeoutMs: options?.totalTimeoutMs,
				abortSignal: options?.abortSignal
			});
		}
		return out;
	}
	const referencedForward = resolveDiscordReferencedForwardMessage(message);
	if (!referencedForward) return out;
	await appendResolvedMediaFromAttachments({
		attachments: referencedForward.attachments,
		maxBytes,
		out,
		errorPrefix: "discord: failed to download forwarded attachment",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	await appendResolvedMediaFromStickers({
		stickers: resolveDiscordMessageStickers(referencedForward),
		maxBytes,
		out,
		errorPrefix: "discord: failed to download forwarded sticker",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	return out;
}
async function resolveReferencedReplyMediaList(message, maxBytes, options) {
	const referencedReply = resolveDiscordReferencedReplyMessage(message);
	const out = [];
	if (!referencedReply) return out;
	const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
	await appendResolvedMediaFromAttachments({
		attachments: referencedReply.attachments,
		maxBytes,
		out,
		errorPrefix: "discord: failed to download referenced reply attachment",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	await appendResolvedMediaFromStickers({
		stickers: resolveDiscordMessageStickers(referencedReply),
		maxBytes,
		out,
		errorPrefix: "discord: failed to download referenced reply sticker",
		fetchImpl: options?.fetchImpl,
		ssrfPolicy: resolvedSsrFPolicy,
		readIdleTimeoutMs: options?.readIdleTimeoutMs,
		totalTimeoutMs: options?.totalTimeoutMs,
		abortSignal: options?.abortSignal
	});
	return out;
}
async function fetchDiscordMedia(params) {
	const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : void 0;
	const signal = mergeAbortSignals([params.abortSignal, timeoutAbortController?.signal]);
	let timedOut = false;
	let timeoutHandle = null;
	const savePromise = saveRemoteMedia({
		url: params.url,
		filePathHint: params.filePathHint,
		maxBytes: params.maxBytes,
		fetchImpl: params.fetchImpl,
		ssrfPolicy: params.ssrfPolicy,
		readIdleTimeoutMs: params.readIdleTimeoutMs,
		fallbackContentType: params.fallbackContentType,
		originalFilename: params.originalFilename,
		...signal ? { requestInit: { signal } } : {}
	}).catch((error) => {
		if (timedOut) return new Promise(() => {});
		throw error;
	});
	try {
		if (!params.totalTimeoutMs) return await savePromise;
		const timeoutPromise = new Promise((_, reject) => {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				timeoutAbortController?.abort();
				reject(/* @__PURE__ */ new Error(`discord media download timed out after ${params.totalTimeoutMs}ms`));
			}, params.totalTimeoutMs);
			timeoutHandle.unref?.();
		});
		return await Promise.race([savePromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}
async function appendResolvedMediaFromAttachments(params) {
	const attachments = params.attachments;
	if (!attachments || attachments.length === 0) return;
	for (const attachment of attachments) {
		const attachmentUrl = normalizeOptionalString(attachment.url);
		if (!attachmentUrl) {
			logVerbose(`${params.errorPrefix} ${attachment.id ?? attachment.filename ?? "attachment"}: missing url`);
			continue;
		}
		try {
			const saved = await fetchDiscordMedia({
				url: attachmentUrl,
				filePathHint: attachment.filename ?? attachmentUrl,
				maxBytes: params.maxBytes,
				fetchImpl: params.fetchImpl,
				ssrfPolicy: params.ssrfPolicy,
				readIdleTimeoutMs: params.readIdleTimeoutMs,
				totalTimeoutMs: params.totalTimeoutMs,
				abortSignal: params.abortSignal,
				fallbackContentType: attachment.content_type,
				originalFilename: attachment.filename
			});
			params.out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: inferPlaceholder(attachment)
			});
		} catch (err) {
			const id = attachment.id ?? attachmentUrl;
			logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
			params.out.push({
				path: attachmentUrl,
				contentType: attachment.content_type,
				placeholder: inferPlaceholder(attachment)
			});
		}
	}
}
function resolveStickerAssetCandidates(sticker) {
	const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
	switch (sticker.format_type) {
		case StickerFormatType.GIF: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.gif`,
			fileName: `${baseName}.gif`
		}];
		case StickerFormatType.Lottie: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png?size=160`,
			fileName: `${baseName}.png`
		}, {
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.json`,
			fileName: `${baseName}.json`
		}];
		case StickerFormatType.APNG:
		case StickerFormatType.PNG:
		default: return [{
			url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png`,
			fileName: `${baseName}.png`
		}];
	}
}
function formatStickerError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err) ?? "unknown error";
	} catch {
		return "unknown error";
	}
}
function inferStickerContentType(sticker) {
	switch (sticker.format_type) {
		case StickerFormatType.GIF: return "image/gif";
		case StickerFormatType.APNG:
		case StickerFormatType.Lottie:
		case StickerFormatType.PNG: return "image/png";
		default: return;
	}
}
async function appendResolvedMediaFromStickers(params) {
	const stickers = params.stickers;
	if (!stickers || stickers.length === 0) return;
	for (const sticker of stickers) {
		const candidates = resolveStickerAssetCandidates(sticker);
		let lastError;
		for (const candidate of candidates) try {
			const saved = await fetchDiscordMedia({
				url: candidate.url,
				filePathHint: candidate.fileName,
				maxBytes: params.maxBytes,
				fetchImpl: params.fetchImpl,
				ssrfPolicy: params.ssrfPolicy,
				readIdleTimeoutMs: params.readIdleTimeoutMs,
				totalTimeoutMs: params.totalTimeoutMs,
				abortSignal: params.abortSignal,
				fallbackContentType: inferStickerContentType(sticker),
				originalFilename: candidate.fileName
			});
			params.out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: "<media:sticker>"
			});
			lastError = null;
			break;
		} catch (err) {
			lastError = err;
		}
		if (lastError) {
			logVerbose(`${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`);
			const fallback = candidates[0];
			if (fallback) params.out.push({
				path: fallback.url,
				contentType: inferStickerContentType(sticker),
				placeholder: "<media:sticker>"
			});
		}
	}
}
function inferPlaceholder(attachment) {
	const mime = attachment.content_type ?? "";
	if (mime.startsWith("image/")) return "<media:image>";
	if (mime.startsWith("video/")) return "<media:video>";
	if (mime.startsWith("audio/")) return "<media:audio>";
	if (hasDiscordVoiceAttachmentFields(attachment)) return "<media:audio>";
	if (isDiscordAudioAttachmentFileName(attachment.filename ?? attachment.url)) return "<media:audio>";
	return "<media:document>";
}
function isImageAttachment(attachment) {
	if ((attachment.content_type ?? "").startsWith("image/")) return true;
	const name = normalizeLowercaseStringOrEmpty(attachment.filename);
	if (!name) return false;
	return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}
function buildDiscordAttachmentPlaceholder(attachments) {
	if (!attachments || attachments.length === 0) return "";
	const count = attachments.length;
	const allImages = attachments.every(isImageAttachment);
	const label = allImages ? "image" : "file";
	const suffix = count === 1 ? label : `${label}s`;
	return `${allImages ? "<media:image>" : "<media:document>"} (${count} ${suffix})`;
}
function buildDiscordStickerPlaceholder(stickers) {
	if (!stickers || stickers.length === 0) return "";
	const count = stickers.length;
	return `<media:sticker> (${count} ${count === 1 ? "sticker" : "stickers"})`;
}
function buildDiscordMediaPlaceholder(params) {
	const attachmentText = buildDiscordAttachmentPlaceholder(params.attachments);
	const stickerText = buildDiscordStickerPlaceholder(params.stickers);
	if (attachmentText && stickerText) return `${attachmentText}\n${stickerText}`;
	return attachmentText || stickerText || "";
}
function buildDiscordMediaPayload(mediaList) {
	return buildMediaPayload(mediaList);
}
//#endregion
//#region extensions/discord/src/monitor/message-text.ts
function resolveDiscordEmbedText(embed) {
	const title = normalizeOptionalString(embed?.title) ?? "";
	const description = normalizeOptionalString(embed?.description) ?? "";
	if (title && description) return `${title}\n${description}`;
	return title || description || "";
}
function resolveDiscordMessageText(message, options) {
	const embedText = resolveDiscordEmbedText(message.embeds?.[0] ?? null);
	const componentText = extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message));
	const baseText = resolveDiscordMentions(normalizeOptionalString(message.content) || buildDiscordMediaPlaceholder({
		attachments: message.attachments ?? void 0,
		stickers: resolveDiscordMessageStickers(message)
	}) || embedText || componentText || normalizeOptionalString(options?.fallbackText) || "", message);
	if (!options?.includeForwarded) return baseText;
	const forwardedText = resolveDiscordForwardedMessagesText(message);
	if (!forwardedText) return baseText;
	if (!baseText) return forwardedText;
	return `${baseText}\n${forwardedText}`;
}
function resolveDiscordMentions(text, message) {
	if (!text.includes("<")) return text;
	const mentions = message.mentionedUsers ?? [];
	if (!Array.isArray(mentions) || mentions.length === 0) return text;
	let out = text;
	for (const user of mentions) {
		const label = user.globalName || user.username;
		out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${label}`);
	}
	return out;
}
function resolveDiscordForwardedMessagesText(message) {
	const snapshots = resolveDiscordMessageSnapshots(message);
	if (snapshots.length > 0) return resolveDiscordForwardedMessagesTextFromSnapshots(snapshots);
	const referencedForward = resolveDiscordReferencedForwardMessage(message);
	if (!referencedForward) return "";
	const referencedText = resolveDiscordMessageText(referencedForward);
	if (!referencedText) return "";
	const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
	return `${authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]"}\n${referencedText}`;
}
function resolveDiscordMessageComponents(message) {
	const components = message.components;
	if (components !== void 0) return components;
	try {
		return message.rawData?.components;
	} catch {
		return;
	}
}
function extractDiscordComponentsV2Text(components) {
	const parts = [];
	collectDiscordTextDisplayContent(components, parts);
	return parts.join("\n");
}
function collectDiscordTextDisplayContent(value, parts) {
	if (Array.isArray(value)) {
		for (const entry of value) collectDiscordTextDisplayContent(entry, parts);
		return;
	}
	if (!value || typeof value !== "object") return;
	const component = value;
	if (component.type === ComponentType.TextDisplay) {
		const content = normalizeOptionalString(component.content);
		if (content) parts.push(content);
	}
	collectDiscordTextDisplayContent(component.components, parts);
	collectDiscordTextDisplayContent(component.component, parts);
}
function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots) {
	const forwardedBlocks = normalizeDiscordMessageSnapshots(snapshots).map((snapshot) => buildDiscordForwardedMessageBlock(snapshot.message)).filter((entry) => Boolean(entry));
	if (forwardedBlocks.length === 0) return "";
	return forwardedBlocks.join("\n\n");
}
function buildDiscordForwardedMessageBlock(snapshotMessage) {
	if (!snapshotMessage) return null;
	const text = resolveDiscordSnapshotMessageText(snapshotMessage);
	if (!text) return null;
	const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
	return `${authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]"}\n${text}`;
}
function resolveDiscordSnapshotMessageText(snapshot) {
	const content = normalizeOptionalString(snapshot.content) ?? "";
	const attachmentText = buildDiscordMediaPlaceholder({
		attachments: snapshot.attachments ?? void 0,
		stickers: resolveDiscordSnapshotStickers(snapshot)
	});
	const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
	const componentText = extractDiscordComponentsV2Text(snapshot.components);
	return content || attachmentText || embedText || componentText || "";
}
//#endregion
export { resolveForwardedMediaList as a, hasDiscordMessageStickers as c, resolveDiscordMessageChannelId as d, buildDiscordMediaPayload as i, resolveDiscordMessageStickers as l, resolveDiscordForwardedMessagesTextFromSnapshots as n, resolveMediaList as o, resolveDiscordMessageText as r, resolveReferencedReplyMediaList as s, resolveDiscordEmbedText as t, resolveDiscordChannelInfo as u };
