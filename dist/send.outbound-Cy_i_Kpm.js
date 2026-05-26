import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { n as recordChannelActivity } from "./channel-activity-eMQlJ3BE.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import "./reply-chunking-D-imiKW4.js";
import "./text-chunking-C154U6-i.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import { s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { $ as createChannelMessage, It as ChannelType, et as createThread } from "./discord-Cn5UmvYW.js";
import { M as createDiscordClient, _ as resolveDiscordMessageFlags, a as normalizeDiscordPollInput, c as normalizeStickerIds, f as sendDiscordMedia, g as buildDiscordMessageRequest, j as parseAndResolveRecipient, l as resolveChannelId, n as buildDiscordTextChunks, p as sendDiscordText, t as buildDiscordSendError, u as resolveDiscordChannelType, v as resolveDiscordSendComponents, y as resolveDiscordSendEmbeds } from "./send.shared-DBAwZLzi.js";
import { n as rewriteDiscordKnownMentions } from "./mentions-C321Y4sH.js";
import { n as createDiscordSendResult } from "./send.receipt-qNc0Gu3O.js";
//#region extensions/discord/src/send.outbound.ts
const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
async function sendDiscordThreadTextChunks(params) {
	for (const chunk of params.chunks) await sendDiscordText(params.rest, params.threadId, chunk, void 0, params.request, params.maxLinesPerMessage, void 0, void 0, params.chunkMode, params.silent, params.suppressEmbeds, params.maxChars);
}
function resolveDiscordSuppressEmbeds(params) {
	return params.override ?? params.configured ?? true;
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
	const suppressEmbeds = resolveDiscordSuppressEmbeds({
		configured: accountInfo.config.suppressEmbeds,
		override: opts.suppressEmbeds
	});
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
		const starterComponents = resolveDiscordSendComponents({
			components: opts.components,
			text: starterContent,
			isFirst: true
		});
		const starterEmbeds = resolveDiscordSendEmbeds({
			embeds: opts.embeds,
			isFirst: true
		});
		const starterBody = buildDiscordMessageRequest({
			text: starterContent,
			components: starterComponents,
			embeds: starterEmbeds,
			flags: resolveDiscordMessageFlags({
				silent: opts.silent,
				suppressEmbeds: suppressEmbeds && !starterEmbeds?.length
			})
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
				await sendDiscordMedia(rest, threadId, mediaCaption ?? "", opts.mediaUrl, opts.filename, opts.mediaAccess, opts.mediaLocalRoots, opts.mediaReadFile, mediaMaxBytes, void 0, request, maxLinesPerMessage, void 0, void 0, chunkMode, opts.silent, suppressEmbeds, textLimit);
				await sendDiscordThreadTextChunks({
					rest,
					threadId,
					chunks: afterMediaChunks,
					request,
					maxLinesPerMessage,
					chunkMode,
					maxChars: textLimit,
					silent: opts.silent,
					suppressEmbeds
				});
			} else await sendDiscordThreadTextChunks({
				rest,
				threadId,
				chunks: remainingChunks,
				request,
				maxLinesPerMessage,
				chunkMode,
				maxChars: textLimit,
				silent: opts.silent,
				suppressEmbeds
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
		if (opts.mediaUrl) result = await sendDiscordMedia(rest, channelId, textWithMentions, opts.mediaUrl, opts.filename, opts.mediaAccess, opts.mediaLocalRoots, opts.mediaReadFile, mediaMaxBytes, opts.replyTo, request, maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent, suppressEmbeds, textLimit);
		else result = await sendDiscordText(rest, channelId, textWithMentions, opts.replyTo, request, maxLinesPerMessage, opts.components, opts.embeds, chunkMode, opts.silent, suppressEmbeds, textLimit);
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
	const { rest, request, channelId, rewrittenContent, suppressEmbeds } = await resolveDiscordStructuredSendContext(to, opts);
	const stickers = normalizeStickerIds(stickerIds);
	const flags = resolveDiscordMessageFlags({ suppressEmbeds });
	return toDiscordSendResult(await request(() => createChannelMessage(rest, channelId, { body: {
		content: rewrittenContent || void 0,
		sticker_ids: stickers,
		...flags ? { flags } : {}
	} }), "sticker"), channelId, { kind: "card" });
}
async function sendPollDiscord(to, poll, opts) {
	const { rest, request, channelId, rewrittenContent, suppressEmbeds } = await resolveDiscordStructuredSendContext(to, opts);
	if (poll.durationSeconds !== void 0) throw new Error("Discord polls do not support durationSeconds; use durationHours");
	const payload = normalizeDiscordPollInput(poll);
	const flags = resolveDiscordMessageFlags({
		silent: opts.silent,
		suppressEmbeds
	});
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
		}) : void 0,
		suppressEmbeds: resolveDiscordSuppressEmbeds({
			configured: accountInfo.config.suppressEmbeds,
			override: opts.suppressEmbeds
		})
	};
}
//#endregion
export { sendPollDiscord as n, sendStickerDiscord as r, sendMessageDiscord as t };
