import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { s as resolveDiscordAccount } from "./accounts-CaHGiVB4.js";
import { $ as createChannelMessage, At as putChannelPermission, Ct as getGuildVoiceState, Dt as listGuildRoles, Et as listGuildEmojis, Mt as removeGuildMemberRole, Nt as timeoutGuildMember, Ot as listGuildScheduledEvents, Q as listMessageReactionUsers, St as getGuildMember, Tt as listGuildChannels, X as createOwnMessageReaction, Z as deleteOwnMessageReaction, _ as readDiscordMessage, _t as createGuildEmoji, at as getChannel, bt as deleteChannelPermission, ct as listChannelMessages, dt as searchGuildMessages, et as createThread, ft as sendChannelTyping, g as readDiscordCode, gt as createGuildChannel, h as RateLimitError, ht as createGuildBan, it as editChannelMessage, jt as removeGuildMember, kt as moveGuildChannels, lt as listChannelPins, m as DiscordError, mt as addGuildMemberRole, nt as deleteChannelMessage, ot as getChannelMessage, pt as unpinChannelMessage, rt as editChannel, st as listChannelArchivedThreads, tt as deleteChannel, ut as pinChannelMessage, v as readRetryAfter, vt as createGuildScheduledEvent, wt as listGuildActiveThreads, yt as createGuildSticker } from "./discord-eZlimVfW.js";
import { C as DiscordSendError, D as hasAllGuildPermissionsDiscord, E as fetchMemberGuildPermissionsDiscord, F as resolveDiscordClientAccountContext, I as resolveDiscordRest, M as createDiscordClient, O as hasAnyGuildPermissionDiscord, S as DISCORD_MAX_STICKER_BYTES, T as fetchChannelPermissionsDiscord, b as DISCORD_MAX_EMOJI_BYTES, i as formatReactionEmoji, k as parseAndResolveRecipient, l as resolveChannelId, o as normalizeEmojiName, r as buildReactionIdentifier, s as normalizeReactionEmoji, t as buildDiscordSendError, w as canViewDiscordGuildChannel, x as DISCORD_MAX_EVENT_COVER_BYTES } from "./send.shared-e9Pd_Em0.js";
import { n as rewriteDiscordKnownMentions } from "./mentions-BPZUaFk7.js";
import { n as sendPollDiscord, r as sendStickerDiscord, t as sendMessageDiscord } from "./send.outbound-6KbINW5h.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { ChannelType } from "discord-api-types/v10";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS, extensionForMime, maxBytesForKind, parseFfprobeCodecAndSampleRate, runFfmpeg, runFfprobe, unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
//#region extensions/discord/src/send.channels.ts
async function createChannelDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const body = { name: payload.name };
	if (payload.type !== void 0) body.type = payload.type;
	if (payload.parentId) body.parent_id = payload.parentId;
	if (payload.topic) body.topic = payload.topic;
	if (payload.position !== void 0) body.position = payload.position;
	if (payload.nsfw !== void 0) body.nsfw = payload.nsfw;
	return await createGuildChannel(rest, payload.guildId, { body });
}
async function editChannelDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const body = {};
	if (payload.name !== void 0) body.name = payload.name;
	if (payload.topic !== void 0) body.topic = payload.topic;
	if (payload.position !== void 0) body.position = payload.position;
	if (payload.parentId !== void 0) body.parent_id = payload.parentId;
	if (payload.nsfw !== void 0) body.nsfw = payload.nsfw;
	if (payload.rateLimitPerUser !== void 0) body.rate_limit_per_user = payload.rateLimitPerUser;
	if (payload.archived !== void 0) body.archived = payload.archived;
	if (payload.locked !== void 0) body.locked = payload.locked;
	if (payload.autoArchiveDuration !== void 0) body.auto_archive_duration = payload.autoArchiveDuration;
	if (payload.availableTags !== void 0) body.available_tags = payload.availableTags.map((t) => ({
		...t.id !== void 0 && { id: t.id },
		name: t.name,
		...t.moderated !== void 0 && { moderated: t.moderated },
		...t.emoji_id !== void 0 && { emoji_id: t.emoji_id },
		...t.emoji_name !== void 0 && { emoji_name: t.emoji_name }
	}));
	return await editChannel(rest, payload.channelId, { body });
}
async function deleteChannelDiscord(channelId, opts) {
	await deleteChannel(resolveDiscordRest(opts), channelId);
	return {
		ok: true,
		channelId
	};
}
async function moveChannelDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const body = [{
		id: payload.channelId,
		...payload.parentId !== void 0 && { parent_id: payload.parentId },
		...payload.position !== void 0 && { position: payload.position }
	}];
	await moveGuildChannels(rest, payload.guildId, { body });
	return { ok: true };
}
async function setChannelPermissionDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const body = { type: payload.targetType };
	if (payload.allow !== void 0) body.allow = payload.allow;
	if (payload.deny !== void 0) body.deny = payload.deny;
	await putChannelPermission(rest, payload.channelId, payload.targetId, { body });
	return { ok: true };
}
async function removeChannelPermissionDiscord(channelId, targetId, opts) {
	await deleteChannelPermission(resolveDiscordRest(opts), channelId, targetId);
	return { ok: true };
}
//#endregion
//#region extensions/discord/src/send.emojis-stickers.ts
async function listGuildEmojisDiscord(guildId, opts) {
	return await listGuildEmojis(resolveDiscordRest(opts), guildId);
}
async function uploadEmojiDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const media = await loadWebMediaRaw(payload.mediaUrl, DISCORD_MAX_EMOJI_BYTES);
	const contentType = normalizeOptionalLowercaseString(media.contentType);
	if (!contentType || ![
		"image/png",
		"image/jpeg",
		"image/jpg",
		"image/gif"
	].includes(contentType)) throw new Error("Discord emoji uploads require a PNG, JPG, or GIF image");
	const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
	const roleIds = (payload.roleIds ?? []).map((id) => id.trim()).filter(Boolean);
	return await createGuildEmoji(rest, payload.guildId, { body: {
		name: normalizeEmojiName(payload.name, "Emoji name"),
		image,
		roles: roleIds.length ? roleIds : void 0
	} });
}
async function uploadStickerDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const media = await loadWebMediaRaw(payload.mediaUrl, DISCORD_MAX_STICKER_BYTES);
	const contentType = normalizeOptionalLowercaseString(media.contentType);
	if (!contentType || ![
		"image/png",
		"image/apng",
		"application/json"
	].includes(contentType)) throw new Error("Discord sticker uploads require a PNG, APNG, or Lottie JSON file");
	return await createGuildSticker(rest, payload.guildId, {
		multipartStyle: "form",
		body: {
			name: normalizeEmojiName(payload.name, "Sticker name"),
			description: normalizeEmojiName(payload.description, "Sticker description"),
			tags: normalizeEmojiName(payload.tags, "Sticker tags"),
			files: [{
				data: media.buffer,
				fieldName: "file",
				name: media.fileName ?? "sticker",
				contentType
			}]
		}
	});
}
//#endregion
//#region extensions/discord/src/send.guild.ts
async function fetchMemberInfoDiscord(guildId, userId, opts) {
	return await getGuildMember(resolveDiscordRest(opts), guildId, userId);
}
async function fetchRoleInfoDiscord(guildId, opts) {
	return await listGuildRoles(resolveDiscordRest(opts), guildId);
}
async function addRoleDiscord(payload, opts) {
	await addGuildMemberRole(resolveDiscordRest(opts), payload.guildId, payload.userId, payload.roleId);
	return { ok: true };
}
async function removeRoleDiscord(payload, opts) {
	await removeGuildMemberRole(resolveDiscordRest(opts), payload.guildId, payload.userId, payload.roleId);
	return { ok: true };
}
async function fetchChannelInfoDiscord(channelId, opts) {
	return await getChannel(resolveDiscordRest(opts), channelId);
}
async function listGuildChannelsDiscord(guildId, opts) {
	return await listGuildChannels(resolveDiscordRest(opts), guildId);
}
async function fetchVoiceStatusDiscord(guildId, userId, opts) {
	return await getGuildVoiceState(resolveDiscordRest(opts), guildId, userId);
}
async function listScheduledEventsDiscord(guildId, opts) {
	return await listGuildScheduledEvents(resolveDiscordRest(opts), guildId);
}
const ALLOWED_EVENT_COVER_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif"
]);
async function resolveEventCoverImage(imageUrl, opts) {
	const media = await loadWebMediaRaw(imageUrl, DISCORD_MAX_EVENT_COVER_BYTES, { localRoots: opts?.localRoots });
	const contentType = normalizeOptionalLowercaseString(media.contentType);
	if (!contentType || !ALLOWED_EVENT_COVER_TYPES.has(contentType)) throw new Error(`Discord event cover images must be PNG, JPG, or GIF (got ${contentType ?? "unknown"})`);
	return `data:${contentType};base64,${media.buffer.toString("base64")}`;
}
async function createScheduledEventDiscord(guildId, payload, opts) {
	return await createGuildScheduledEvent(resolveDiscordRest(opts), guildId, payload);
}
async function timeoutMemberDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	let until = payload.until;
	if (!until && payload.durationMinutes) {
		const ms = payload.durationMinutes * 60 * 1e3;
		until = new Date(Date.now() + ms).toISOString();
	}
	return await timeoutGuildMember(rest, payload.guildId, payload.userId, {
		body: { communication_disabled_until: until ?? null },
		headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
	});
}
async function kickMemberDiscord(payload, opts) {
	await removeGuildMember(resolveDiscordRest(opts), payload.guildId, payload.userId, { headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0 });
	return { ok: true };
}
async function banMemberDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	const deleteMessageDays = typeof payload.deleteMessageDays === "number" && Number.isFinite(payload.deleteMessageDays) ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7) : void 0;
	await createGuildBan(rest, payload.guildId, payload.userId, {
		body: deleteMessageDays !== void 0 ? { delete_message_days: deleteMessageDays } : void 0,
		headers: payload.reason ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) } : void 0
	});
	return { ok: true };
}
//#endregion
//#region extensions/discord/src/send.messages.ts
function formatDiscordThreadInitialMessageError(error) {
	return error instanceof Error ? error.message : String(error);
}
var DiscordThreadInitialMessageError = class extends Error {
	constructor(thread, error) {
		const initialMessageError = formatDiscordThreadInitialMessageError(error);
		super(`Discord thread was created, but sending the initial message failed: ${initialMessageError}`);
		this.name = "DiscordThreadInitialMessageError";
		this.initialMessageError = initialMessageError;
		this.thread = thread;
	}
};
async function readMessagesDiscord(channelId, query = {}, opts) {
	const rest = resolveDiscordRest(opts);
	const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.min(Math.max(Math.floor(query.limit), 1), 100) : void 0;
	const params = {};
	if (limit) params.limit = limit;
	if (query.before) params.before = query.before;
	if (query.after) params.after = query.after;
	if (query.around) params.around = query.around;
	return await listChannelMessages(rest, channelId, params);
}
async function fetchMessageDiscord(channelId, messageId, opts) {
	return await getChannelMessage(resolveDiscordRest(opts), channelId, messageId);
}
async function editMessageDiscord(channelId, messageId, payload, opts) {
	return await editChannelMessage(resolveDiscordRest(opts), channelId, messageId, { body: { content: payload.content } });
}
async function deleteMessageDiscord(channelId, messageId, opts) {
	await deleteChannelMessage(resolveDiscordRest(opts), channelId, messageId);
	return { ok: true };
}
async function pinMessageDiscord(channelId, messageId, opts) {
	await pinChannelMessage(resolveDiscordRest(opts), channelId, messageId);
	return { ok: true };
}
async function unpinMessageDiscord(channelId, messageId, opts) {
	await unpinChannelMessage(resolveDiscordRest(opts), channelId, messageId);
	return { ok: true };
}
async function listPinsDiscord(channelId, opts) {
	return await listChannelPins(resolveDiscordRest(opts), channelId);
}
async function createThreadDiscord(channelId, payload, opts) {
	const rest = resolveDiscordRest(opts);
	const body = { name: payload.name };
	if (payload.autoArchiveMinutes) body.auto_archive_duration = payload.autoArchiveMinutes;
	if (!payload.messageId && payload.type !== void 0) body.type = payload.type;
	let channelType;
	if (!payload.messageId) try {
		channelType = (await getChannel(rest, channelId))?.type;
	} catch {
		channelType = void 0;
	}
	const isForumLike = channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
	if (isForumLike) {
		body.message = { content: payload.content?.trim() ? payload.content : payload.name };
		if (payload.appliedTags?.length) body.applied_tags = payload.appliedTags;
	}
	if (!payload.messageId && !isForumLike && body.type === void 0) body.type = ChannelType.PublicThread;
	const thread = await createThread(rest, channelId, { body }, payload.messageId);
	if (!isForumLike && payload.content?.trim() && "id" in thread) try {
		await createChannelMessage(rest, thread.id, { body: { content: payload.content } });
	} catch (error) {
		throw new DiscordThreadInitialMessageError(thread, error);
	}
	return thread;
}
async function listThreadsDiscord(payload, opts) {
	const rest = resolveDiscordRest(opts);
	if (payload.includeArchived) {
		if (!payload.channelId) throw new Error("channelId required to list archived threads");
		const params = {};
		if (payload.before) params.before = payload.before;
		if (payload.limit) params.limit = payload.limit;
		return await listChannelArchivedThreads(rest, payload.channelId, params);
	}
	return await listGuildActiveThreads(rest, payload.guildId);
}
async function searchMessagesDiscord(query, opts) {
	const rest = resolveDiscordRest(opts);
	const params = new URLSearchParams();
	params.set("content", query.content);
	if (query.channelIds?.length) for (const channelId of query.channelIds) params.append("channel_id", channelId);
	if (query.authorIds?.length) for (const authorId of query.authorIds) params.append("author_id", authorId);
	if (query.limit) {
		const limit = Math.min(Math.max(Math.floor(query.limit), 1), 25);
		params.set("limit", String(limit));
	}
	return await searchGuildMessages(rest, query.guildId, params);
}
//#endregion
//#region extensions/discord/src/send.webhook.ts
function resolveWebhookExecutionUrl(params) {
	const baseUrl = new URL(`https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`);
	baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
	if (params.threadId !== void 0 && params.threadId !== null && params.threadId !== "") baseUrl.searchParams.set("thread_id", String(params.threadId));
	return baseUrl.toString();
}
function coerceWebhookErrorBody(raw) {
	if (!raw) return;
	try {
		return JSON.parse(raw);
	} catch {
		return { message: raw.slice(0, 200) };
	}
}
async function throwWebhookResponseError(response) {
	const parsed = coerceWebhookErrorBody(await response.text().catch(() => ""));
	if (response.status === 429) throw new RateLimitError(response, {
		message: readDiscordMessage(parsed, "Rate limited"),
		retry_after: readRetryAfter(parsed, response, 1),
		code: readDiscordCode(parsed),
		global: parsed && typeof parsed === "object" && "global" in parsed ? Boolean(parsed.global) : false
	});
	throw new DiscordError(response, parsed);
}
async function sendWebhookMessageDiscord(text, opts) {
	const webhookId = normalizeOptionalString(opts.webhookId) ?? "";
	const webhookToken = normalizeOptionalString(opts.webhookToken) ?? "";
	if (!webhookId || !webhookToken) throw new Error("Discord webhook id/token are required");
	const replyTo = normalizeOptionalString(opts.replyTo) ?? "";
	const messageReference = replyTo ? {
		message_id: replyTo,
		fail_if_not_exists: false
	} : void 0;
	const { account, proxyFetch } = resolveDiscordClientAccountContext({
		cfg: opts.cfg,
		accountId: opts.accountId
	});
	const rewrittenText = rewriteDiscordKnownMentions(text, {
		accountId: account.accountId,
		mentionAliases: account.config.mentionAliases
	});
	const response = await (proxyFetch ?? fetch)(resolveWebhookExecutionUrl({
		webhookId,
		webhookToken,
		threadId: opts.threadId,
		wait: opts.wait
	}), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			content: rewrittenText,
			username: normalizeOptionalString(opts.username),
			avatar_url: normalizeOptionalString(opts.avatarUrl),
			...messageReference ? { message_reference: messageReference } : {}
		})
	});
	if (!response.ok) await throwWebhookResponseError(response);
	const payload = await response.json().catch(() => ({}));
	try {
		recordChannelActivity({
			channel: "discord",
			accountId: account.accountId,
			direction: "outbound"
		});
	} catch {}
	return {
		messageId: payload.id || "unknown",
		channelId: payload.channel_id ? payload.channel_id : opts.threadId ? String(opts.threadId) : ""
	};
}
//#endregion
//#region extensions/discord/src/voice-message.ts
/**
* Discord Voice Message Support
*
* Implements sending voice messages via Discord's API.
* Voice messages require:
* - OGG/Opus format audio
* - Waveform data (base64 encoded, up to 256 samples, 0-255 values)
* - Duration in seconds
* - Message flag 8192 (IS_VOICE_MESSAGE)
* - No other content (text, embeds, etc.)
*/
const DISCORD_VOICE_MESSAGE_FLAG = 8192;
const SUPPRESS_NOTIFICATIONS_FLAG = 4096;
const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48e3;
function createRateLimitError(response, body, request) {
	return new RateLimitError(response, body, request ?? new Request("https://discord.com/api/v10/channels/voice/messages", { method: "POST" }));
}
/**
* Get audio duration using ffprobe
*/
async function getAudioDuration(filePath) {
	try {
		const stdout = await runFfprobe([
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			filePath
		]);
		const duration = Number.parseFloat(stdout.trim());
		if (Number.isNaN(duration)) throw new Error("Could not parse duration");
		return Math.round(duration * 100) / 100;
	} catch (err) {
		const errMessage = formatErrorMessage(err);
		throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
	}
}
/**
* Generate waveform data from audio file using ffmpeg
* Returns base64 encoded byte array of amplitude samples (0-255)
*/
async function generateWaveform(filePath) {
	try {
		return await generateWaveformFromPcm(filePath);
	} catch {
		return generatePlaceholderWaveform();
	}
}
/**
* Generate waveform by extracting raw PCM data and sampling amplitudes
*/
async function generateWaveformFromPcm(filePath) {
	const tempDir = resolvePreferredOpenClawTmpDir();
	const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);
	try {
		await runFfmpeg([
			"-y",
			"-i",
			filePath,
			"-vn",
			"-sn",
			"-dn",
			"-t",
			String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
			"-f",
			"s16le",
			"-acodec",
			"pcm_s16le",
			"-ac",
			"1",
			"-ar",
			"8000",
			tempPcm
		]);
		const pcmData = await fs.readFile(tempPcm);
		const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
		const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
		const waveform = [];
		for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
			let sum = 0;
			let count = 0;
			for (let j = 0; j < step && i * step + j < samples.length; j++) {
				sum += Math.abs(samples[i * step + j]);
				count++;
			}
			const avg = count > 0 ? sum / count : 0;
			const normalized = Math.min(255, Math.round(avg / 32767 * 255));
			waveform.push(normalized);
		}
		while (waveform.length < WAVEFORM_SAMPLES) waveform.push(0);
		return Buffer.from(waveform).toString("base64");
	} finally {
		await unlinkIfExists(tempPcm);
	}
}
/**
* Generate a placeholder waveform (for when audio processing fails)
*/
function generatePlaceholderWaveform() {
	const waveform = [];
	for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
		const value = Math.round(128 + 64 * Math.sin(i / WAVEFORM_SAMPLES * Math.PI * 8));
		waveform.push(Math.min(255, Math.max(0, value)));
	}
	return Buffer.from(waveform).toString("base64");
}
/**
* Convert audio file to OGG/Opus format if needed
* Returns path to the OGG file (may be same as input if already OGG/Opus)
*/
async function ensureOggOpus(filePath) {
	const trimmed = filePath.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) throw new Error(`Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`);
	if (normalizeLowercaseStringOrEmpty(path.extname(filePath)) === ".ogg") try {
		const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(await runFfprobe([
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"stream=codec_name,sample_rate",
			"-of",
			"csv=p=0",
			filePath
		]));
		if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) return {
			path: filePath,
			cleanup: false
		};
	} catch {}
	const tempDir = resolvePreferredOpenClawTmpDir();
	const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);
	await runFfmpeg([
		"-y",
		"-i",
		filePath,
		"-vn",
		"-sn",
		"-dn",
		"-t",
		String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
		"-ar",
		String(DISCORD_OPUS_SAMPLE_RATE_HZ),
		"-c:a",
		"libopus",
		"-b:a",
		"64k",
		outputPath
	]);
	return {
		path: outputPath,
		cleanup: true
	};
}
/**
* Get voice message metadata (duration and waveform)
*/
async function getVoiceMessageMetadata(filePath) {
	const [durationSecs, waveform] = await Promise.all([getAudioDuration(filePath), generateWaveform(filePath)]);
	return {
		durationSecs,
		waveform
	};
}
function coerceDiscordErrorBody(raw) {
	if (!raw) return;
	try {
		return JSON.parse(raw);
	} catch {
		return { message: raw.slice(0, 200) };
	}
}
async function createVoiceRequestError(response, fallbackMessage) {
	const parsed = coerceDiscordErrorBody(await response.text().catch(() => ""));
	if (response.status === 429) throw createRateLimitError(response, {
		message: readDiscordMessage(parsed, "You are being rate limited."),
		retry_after: readRetryAfter(parsed, response, 1),
		global: parsed && typeof parsed === "object" && "global" in parsed ? Boolean(parsed.global) : false
	});
	return new DiscordError(response, parsed ?? { message: fallbackMessage });
}
async function requestVoiceUploadUrl(params) {
	const { response: res, release } = await fetchWithSsrFGuard({
		url: `${params.rest.options?.baseUrl ?? "https://discord.com/api"}/channels/${params.channelId}/attachments`,
		init: {
			method: "POST",
			headers: {
				Authorization: `Bot ${params.botToken}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ files: [{
				filename: params.filename,
				file_size: params.fileSize,
				id: "0"
			}] })
		},
		auditContext: "discord.voice.upload-url"
	});
	try {
		if (!res.ok) throw await createVoiceRequestError(res, "Upload URL request failed");
		return await res.json();
	} finally {
		await release();
	}
}
async function uploadVoiceAttachment(params) {
	const { response: uploadResponse, release } = await fetchWithSsrFGuard({
		url: params.uploadUrl,
		init: {
			method: "PUT",
			headers: { "Content-Type": "audio/ogg" },
			body: new Uint8Array(params.audioBuffer)
		},
		auditContext: "discord.voice.attachment-upload"
	});
	try {
		if (!uploadResponse.ok) throw await createVoiceRequestError(uploadResponse, "Failed to upload voice message");
	} finally {
		await release();
	}
}
/**
* Send a voice message to Discord
*
* This follows Discord's voice message protocol:
* 1. Request upload URL from Discord
* 2. Upload the OGG file to the provided URL
* 3. Send the message with flag 8192 and attachment metadata
*/
async function sendDiscordVoiceMessage(rest, channelId, audioBuffer, metadata, replyTo, request, silent, token) {
	const filename = "voice-message.ogg";
	const fileSize = audioBuffer.byteLength;
	const botToken = token;
	if (!botToken) throw new Error("Discord bot token is required for voice message upload");
	const { upload_filename } = await request(async () => {
		const uploadUrlResponse = await requestVoiceUploadUrl({
			rest,
			channelId,
			botToken,
			filename,
			fileSize
		});
		if (!uploadUrlResponse.attachments?.[0]) throw new Error("Failed to get upload URL for voice message");
		const attachment = uploadUrlResponse.attachments[0];
		await uploadVoiceAttachment({
			uploadUrl: attachment.upload_url,
			audioBuffer
		});
		return attachment;
	}, "voice-upload");
	const messagePayload = {
		flags: silent ? DISCORD_VOICE_MESSAGE_FLAG | SUPPRESS_NOTIFICATIONS_FLAG : DISCORD_VOICE_MESSAGE_FLAG,
		attachments: [{
			id: "0",
			filename,
			uploaded_filename: upload_filename,
			duration_secs: metadata.durationSecs,
			waveform: metadata.waveform
		}]
	};
	if (replyTo) messagePayload.message_reference = {
		message_id: replyTo,
		fail_if_not_exists: false
	};
	return await request(() => rest.post(`/channels/${channelId}/messages`, { body: messagePayload }), "voice-message");
}
//#endregion
//#region extensions/discord/src/send.voice.ts
function toDiscordSendResult(result, fallbackChannelId) {
	return {
		messageId: result.id || "unknown",
		channelId: result.channel_id ?? fallbackChannelId
	};
}
async function materializeVoiceMessageInput(mediaUrl) {
	const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
	const extFromName = media.fileName ? path.extname(media.fileName) : "";
	const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
	const ext = extFromName || extFromMime || ".bin";
	const tempDir = resolvePreferredOpenClawTmpDir();
	const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
	await fs.writeFile(filePath, media.buffer, { mode: 384 });
	return { filePath };
}
/**
* Send a voice message to Discord.
*
* Voice messages are a special Discord feature that displays audio with a waveform
* visualization. They require OGG/Opus format and cannot include text content.
*
* @param to - Recipient (user ID for DM or channel ID)
* @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
* @param opts - Send options
*/
async function sendVoiceMessageDiscord(to, audioPath, opts) {
	const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
	let oggPath = null;
	let oggCleanup = false;
	let token;
	let rest;
	let channelId;
	const cfg = requireRuntimeConfig(opts.cfg, "Discord voice send");
	try {
		const accountInfo = resolveDiscordAccount({
			cfg,
			accountId: opts.accountId
		});
		const client = createDiscordClient({
			...opts,
			cfg
		});
		token = client.token;
		rest = client.rest;
		const request = client.request;
		const recipient = await parseAndResolveRecipient(to, cfg, opts.accountId);
		channelId = (await resolveChannelId(rest, recipient, request)).channelId;
		const ogg = await ensureOggOpus(localInputPath);
		oggPath = ogg.path;
		oggCleanup = ogg.cleanup;
		const metadata = await getVoiceMessageMetadata(oggPath);
		const audioBuffer = await fs.readFile(oggPath);
		const result = await sendDiscordVoiceMessage(rest, channelId, audioBuffer, metadata, opts.replyTo, request, opts.silent, token);
		recordChannelActivity({
			channel: "discord",
			accountId: accountInfo.accountId,
			direction: "outbound"
		});
		return toDiscordSendResult(result, channelId);
	} catch (err) {
		if (channelId && rest && token) throw await buildDiscordSendError(err, {
			channelId,
			cfg,
			rest,
			token,
			hasMedia: true
		});
		throw err;
	} finally {
		await unlinkIfExists(oggCleanup ? oggPath : null);
		await unlinkIfExists(localInputPath);
	}
}
//#endregion
//#region extensions/discord/src/send.typing.ts
async function sendTypingDiscord(channelId, opts) {
	await sendChannelTyping(resolveDiscordRest(opts), channelId);
	return {
		ok: true,
		channelId
	};
}
//#endregion
//#region extensions/discord/src/send.reactions.ts
function createDiscordReactionRuntimeClient(opts) {
	return createDiscordClient(opts);
}
function resolveDiscordReactionClient(opts) {
	if (!opts.cfg) throw new Error("Discord reactions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const cfg = requireRuntimeConfig(opts.cfg, "Discord reactions");
	return createDiscordClient({
		...opts,
		cfg
	});
}
function isDiscordReactionRuntimeContext(opts) {
	return Boolean(opts.rest && opts.cfg && opts.accountId);
}
async function reactMessageDiscord(channelId, messageId, emoji, opts) {
	const { rest, request } = isDiscordReactionRuntimeContext(opts) ? createDiscordReactionRuntimeClient(opts) : resolveDiscordReactionClient(opts);
	const encoded = normalizeReactionEmoji(emoji);
	await request(() => createOwnMessageReaction(rest, channelId, messageId, encoded), "react");
	return { ok: true };
}
async function removeReactionDiscord(channelId, messageId, emoji, opts) {
	const { rest } = isDiscordReactionRuntimeContext(opts) ? createDiscordReactionRuntimeClient(opts) : resolveDiscordReactionClient(opts);
	await deleteOwnMessageReaction(rest, channelId, messageId, normalizeReactionEmoji(emoji));
	return { ok: true };
}
async function removeOwnReactionsDiscord(channelId, messageId, opts) {
	const { rest } = isDiscordReactionRuntimeContext(opts) ? createDiscordReactionRuntimeClient(opts) : resolveDiscordReactionClient(opts);
	const message = await getChannelMessage(rest, channelId, messageId);
	const identifiers = /* @__PURE__ */ new Set();
	for (const reaction of message.reactions ?? []) {
		const identifier = buildReactionIdentifier(reaction.emoji);
		if (identifier) identifiers.add(identifier);
	}
	if (identifiers.size === 0) return {
		ok: true,
		removed: []
	};
	const removed = [];
	await Promise.allSettled(Array.from(identifiers, (identifier) => {
		removed.push(identifier);
		return deleteOwnMessageReaction(rest, channelId, messageId, normalizeReactionEmoji(identifier));
	}));
	return {
		ok: true,
		removed
	};
}
async function fetchReactionsDiscord(channelId, messageId, opts) {
	const { rest } = isDiscordReactionRuntimeContext(opts) ? createDiscordReactionRuntimeClient(opts) : resolveDiscordReactionClient(opts);
	const reactions = (await getChannelMessage(rest, channelId, messageId)).reactions ?? [];
	if (reactions.length === 0) return [];
	const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) ? Math.min(Math.max(Math.floor(opts.limit), 1), 100) : 100;
	const summaries = [];
	for (const reaction of reactions) {
		const identifier = buildReactionIdentifier(reaction.emoji);
		if (!identifier) continue;
		const users = await listMessageReactionUsers(rest, channelId, messageId, encodeURIComponent(identifier), { limit });
		summaries.push({
			emoji: {
				id: reaction.emoji.id ?? null,
				name: reaction.emoji.name ?? null,
				raw: formatReactionEmoji(reaction.emoji)
			},
			count: reaction.count,
			users: users.map((user) => ({
				id: user.id,
				username: user.username,
				tag: user.username && user.discriminator ? `${user.username}#${user.discriminator}` : user.username
			}))
		});
	}
	return summaries;
}
//#endregion
//#region extensions/discord/src/send.ts
var send_exports = /* @__PURE__ */ __exportAll({
	DiscordSendError: () => DiscordSendError,
	DiscordThreadInitialMessageError: () => DiscordThreadInitialMessageError,
	addRoleDiscord: () => addRoleDiscord,
	banMemberDiscord: () => banMemberDiscord,
	canViewDiscordGuildChannel: () => canViewDiscordGuildChannel,
	createChannelDiscord: () => createChannelDiscord,
	createScheduledEventDiscord: () => createScheduledEventDiscord,
	createThreadDiscord: () => createThreadDiscord,
	deleteChannelDiscord: () => deleteChannelDiscord,
	deleteMessageDiscord: () => deleteMessageDiscord,
	editChannelDiscord: () => editChannelDiscord,
	editMessageDiscord: () => editMessageDiscord,
	fetchChannelInfoDiscord: () => fetchChannelInfoDiscord,
	fetchChannelPermissionsDiscord: () => fetchChannelPermissionsDiscord,
	fetchMemberGuildPermissionsDiscord: () => fetchMemberGuildPermissionsDiscord,
	fetchMemberInfoDiscord: () => fetchMemberInfoDiscord,
	fetchMessageDiscord: () => fetchMessageDiscord,
	fetchReactionsDiscord: () => fetchReactionsDiscord,
	fetchRoleInfoDiscord: () => fetchRoleInfoDiscord,
	fetchVoiceStatusDiscord: () => fetchVoiceStatusDiscord,
	hasAllGuildPermissionsDiscord: () => hasAllGuildPermissionsDiscord,
	hasAnyGuildPermissionDiscord: () => hasAnyGuildPermissionDiscord,
	kickMemberDiscord: () => kickMemberDiscord,
	listGuildChannelsDiscord: () => listGuildChannelsDiscord,
	listGuildEmojisDiscord: () => listGuildEmojisDiscord,
	listPinsDiscord: () => listPinsDiscord,
	listScheduledEventsDiscord: () => listScheduledEventsDiscord,
	listThreadsDiscord: () => listThreadsDiscord,
	moveChannelDiscord: () => moveChannelDiscord,
	pinMessageDiscord: () => pinMessageDiscord,
	reactMessageDiscord: () => reactMessageDiscord,
	readMessagesDiscord: () => readMessagesDiscord,
	removeChannelPermissionDiscord: () => removeChannelPermissionDiscord,
	removeOwnReactionsDiscord: () => removeOwnReactionsDiscord,
	removeReactionDiscord: () => removeReactionDiscord,
	removeRoleDiscord: () => removeRoleDiscord,
	resolveEventCoverImage: () => resolveEventCoverImage,
	searchMessagesDiscord: () => searchMessagesDiscord,
	sendMessageDiscord: () => sendMessageDiscord,
	sendPollDiscord: () => sendPollDiscord,
	sendStickerDiscord: () => sendStickerDiscord,
	sendTypingDiscord: () => sendTypingDiscord,
	sendVoiceMessageDiscord: () => sendVoiceMessageDiscord,
	sendWebhookMessageDiscord: () => sendWebhookMessageDiscord,
	setChannelPermissionDiscord: () => setChannelPermissionDiscord,
	timeoutMemberDiscord: () => timeoutMemberDiscord,
	unpinMessageDiscord: () => unpinMessageDiscord,
	uploadEmojiDiscord: () => uploadEmojiDiscord,
	uploadStickerDiscord: () => uploadStickerDiscord
});
//#endregion
export { removeRoleDiscord as A, removeChannelPermissionDiscord as B, fetchChannelInfoDiscord as C, kickMemberDiscord as D, fetchVoiceStatusDiscord as E, uploadStickerDiscord as F, createChannelDiscord as I, deleteChannelDiscord as L, timeoutMemberDiscord as M, listGuildEmojisDiscord as N, listGuildChannelsDiscord as O, uploadEmojiDiscord as P, editChannelDiscord as R, createScheduledEventDiscord as S, fetchRoleInfoDiscord as T, setChannelPermissionDiscord as V, readMessagesDiscord as _, removeReactionDiscord as a, addRoleDiscord as b, sendWebhookMessageDiscord as c, deleteMessageDiscord as d, editMessageDiscord as f, pinMessageDiscord as g, listThreadsDiscord as h, removeOwnReactionsDiscord as i, resolveEventCoverImage as j, listScheduledEventsDiscord as k, DiscordThreadInitialMessageError as l, listPinsDiscord as m, fetchReactionsDiscord as n, sendTypingDiscord as o, fetchMessageDiscord as p, reactMessageDiscord as r, sendVoiceMessageDiscord as s, send_exports as t, createThreadDiscord as u, searchMessagesDiscord as v, fetchMemberInfoDiscord as w, banMemberDiscord as x, unpinMessageDiscord as y, moveChannelDiscord as z };
