import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { s as resolveChunkMode } from "./chunk-CGVwhsnj.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-CCZPL3sp.js";
import { n as recordChannelActivity } from "./channel-activity-zWUQ9Yny.js";
import { t as convertMarkdownTables } from "./tables-Bk81cN4I.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DyMlx_D0.js";
import "./reply-chunking-DnJ1jlVh.js";
import "./text-chunking-3_9rfiI8.js";
import "./markdown-table-runtime-BtsiVyHf.js";
import { s as resolveDiscordAccount } from "./accounts-mQquCOrG.js";
import { $ as createChannelMessage, It as ChannelType, et as createThread } from "./discord-BzIosOJb.js";
import { A as createDiscordClient, _ as resolveDiscordSendComponents, a as normalizeDiscordPollInput, c as normalizeStickerIds, f as sendDiscordMedia, g as buildDiscordMessageRequest, h as SUPPRESS_NOTIFICATIONS_FLAG, k as parseAndResolveRecipient, l as resolveChannelId, n as buildDiscordTextChunks, p as sendDiscordText, t as buildDiscordSendError, u as resolveDiscordChannelType, v as resolveDiscordSendEmbeds } from "./send.shared-CfZ7SvSu.js";
import { n as rewriteDiscordKnownMentions } from "./mentions-Cc_buFjO.js";
import { n as createDiscordSendResult } from "./send.receipt-COBSsHa4.js";
//#region extensions/discord/src/send.outbound.ts
const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
async function sendDiscordThreadTextChunks(params) {
	for (const chunk of params.chunks) await sendDiscordText(params.rest, params.threadId, chunk, void 0, params.request, params.maxLinesPerMessage, void 0, void 0, params.chunkMode, params.silent, params.maxChars);
}
/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;
/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text) {
	return (normalizeOptionalString(text.split("\n").find((line) => normalizeOptionalString(line))) ?? "").slice(0, DISCORD_THREAD_NAME_LIMIT) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 16);
}
/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeType(channelType) {
	return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}
function toDiscordSendResult(result, fallbackChannelId, params = {}) {
	const resultParams = {
		result,
		fallbackChannelId,
		kind: params.kind ?? "text"
	};
	if (params.threadId != null) resultParams.threadId = params.threadId;
	if (params.replyToId) resultParams.replyToId = params.replyToId;
	return createDiscordSendResult(resultParams);
}
async function resolveDiscordSendTarget(to, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Discord send target resolution");
	const { rest, request } = createDiscordClient({
		...opts,
		cfg
	});
	const { channelId } = await resolveChannelId(rest, await parseAndResolveRecipient(to, cfg, opts.accountId), request);
	return {
		rest,
		request,
		channelId
	};
}
async function sendMessageDiscord(to, text, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Discord send");
	const accountInfo = resolveDiscordAccount({
		cfg,
		accountId: opts.accountId
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "discord",
		accountId: accountInfo.accountId
	});
	const effectiveTableMode = opts.tableMode ?? tableMode;
	const chunkMode = opts.chunkMode ?? resolveChunkMode(cfg, "discord", accountInfo.accountId);
	const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
	const textLimit = typeof opts.textLimit === "number" && Number.isFinite(opts.textLimit) ? Math.max(1, Math.min(Math.floor(opts.textLimit), 2e3)) : void 0;
	const mediaMaxBytes = typeof accountInfo.config.mediaMaxMb === "number" ? accountInfo.config.mediaMaxMb * 1024 * 1024 : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
	const textWithTables = convertMarkdownTables(text ?? "", effectiveTableMode);
	const textWithMentions = rewriteDiscordKnownMentions(textWithTables, {
		accountId: accountInfo.accountId,
		mentionAliases: accountInfo.config.mentionAliases
	});
	const { token, rest, request } = createDiscordClient({
		...opts,
		cfg
	});
	const { channelId } = await resolveChannelId(rest, await parseAndResolveRecipient(to, cfg, opts.accountId), request);
	if (isForumLikeType(await resolveDiscordChannelType(rest, channelId))) {
		const threadName = deriveForumThreadName(textWithTables);
		const chunks = buildDiscordTextChunks(textWithMentions, {
			maxLinesPerMessage,
			chunkMode,
			maxChars: textLimit
		});
		const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
		const starterBody = buildDiscordMessageRequest({
			text: starterContent,
			components: resolveDiscordSendComponents({
				components: opts.components,
				text: starterContent,
				isFirst: true
			}),
			embeds: resolveDiscordSendEmbeds({
				embeds: opts.embeds,
				isFirst: true
			}),
			flags: opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : void 0
		});
		let threadRes;
		try {
			threadRes = await request(() => createThread(rest, channelId, { body: {
				name: threadName,
				message: starterBody
			} }), "forum-thread");
		} catch (err) {
			throw await buildDiscordSendError(err, {
				channelId,
				cfg,
				rest,
				token,
				hasMedia: Boolean(opts.mediaUrl)
			});
		}
		const threadId = threadRes.id;
		const messageId = threadRes.message?.id ?? threadId;
		const resultChannelId = threadRes.message?.channel_id ?? threadId;
		const remainingChunks = chunks.slice(1);
		try {
			if (opts.mediaUrl) {
				const [mediaCaption, ...afterMediaChunks] = remainingChunks;
				await sendDiscordMedia(rest, threadId, mediaCaption ?? "", opts.mediaUrl, opts.filename, opts.mediaAccess, opts.mediaLocalRoots, opts.mediaReadFile, mediaMaxBytes, void 0, request, maxLinesPerMessage, void 0, void 0, chunkMode, opts.silent, textLimit);
				await sendDiscordThreadTextChunks({
					rest,
					threadId,
					chunks: afterMediaChunks,
					request,
					maxLinesPerMessage,
					chunkMode,
					maxChars: textLimit,
					silent: opts.silent
				});
			} else await sendDiscordThreadTextChunks({
				rest,
				threadId,
				chunks: remainingChunks,
				request,
				maxLinesPerMessage,
				chunkMode,
				maxChars: textLimit,
				silent: opts.silent
			});
		} catch (err) {
			throw await buildDiscordSendError(err, {
				channelId: threadId,
				cfg,
				rest,
				token,
				hasMedia: Boolean(opts.mediaUrl)
			});
		}
		recordChannelActivity({
			channel: "discord",
			accountId: accountInfo.accountId,
			direction: "outbound"
		});
		return toDiscordSendResult({
			id: messageId,
			channel_id: resultChannelId
		}, channelId, {
			kind: opts.mediaUrl ? "media" : "text",
			threadId
		});
	}
	let result;
	try {
		if (opts.mediaUrl) result = await sendDiscordMedia(rest, channelId, textWithMentions, opts.mediaUrl, opts.filename, opts.mediaAccess, opts.mediaLocalRoots, opts.mediaReadFile, mediaMaxBytes, opts.replyTo, request, maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent, textLimit);
		else result = await sendDiscordText(rest, channelId, textWithMentions, opts.replyTo, request, maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent, textLimit);
	} catch (err) {
		throw await buildDiscordSendError(err, {
			channelId,
			cfg,
			rest,
			token,
			hasMedia: Boolean(opts.mediaUrl)
		});
	}
	recordChannelActivity({
		channel: "discord",
		accountId: accountInfo.accountId,
		direction: "outbound"
	});
	return toDiscordSendResult(result, channelId, {
		kind: opts.mediaUrl ? "media" : opts.components || opts.embeds ? "card" : "text",
		replyToId: opts.replyTo
	});
}
async function sendStickerDiscord(to, stickerIds, opts) {
	const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(to, opts);
	const stickers = normalizeStickerIds(stickerIds);
	return toDiscordSendResult(await request(() => createChannelMessage(rest, channelId, { body: {
		content: rewrittenContent || void 0,
		sticker_ids: stickers
	} }), "sticker"), channelId, { kind: "card" });
}
async function sendPollDiscord(to, poll, opts) {
	const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(to, opts);
	if (poll.durationSeconds !== void 0) throw new Error("Discord polls do not support durationSeconds; use durationHours");
	const payload = normalizeDiscordPollInput(poll);
	const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : void 0;
	return toDiscordSendResult(await request(() => createChannelMessage(rest, channelId, { body: {
		content: rewrittenContent || void 0,
		poll: payload,
		...flags ? { flags } : {}
	} }), "poll"), channelId, { kind: "card" });
}
async function resolveDiscordStructuredSendContext(to, opts) {
	const accountInfo = resolveDiscordAccount({
		cfg: requireRuntimeConfig(opts.cfg, "Discord structured send"),
		accountId: opts.accountId
	});
	const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
	const content = opts.content?.trim();
	return {
		rest,
		request,
		channelId,
		rewrittenContent: content ? rewriteDiscordKnownMentions(content, {
			accountId: accountInfo.accountId,
			mentionAliases: accountInfo.config.mentionAliases
		}) : void 0
	};
}
//#endregion
export { sendPollDiscord as n, sendStickerDiscord as r, sendMessageDiscord as t };
