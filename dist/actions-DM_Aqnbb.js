import { r as logVerbose } from "./globals-CouSpJO4.js";
import "./runtime-env-AKjXcC53.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DyMlx_D0.js";
import { a as resolveSlackAccount, d as resolveSlackBotToken } from "./accounts-Ba1LnRZV.js";
import { i as truncateSlackText, r as SLACK_TEXT_LIMIT } from "./thread-ts-DWLXPVhT.js";
import { a as getSlackWriteClient, r as createSlackWebClient } from "./client-BY5LT_WB.js";
import { r as validateSlackBlocksArray } from "./blocks-input-BkCFIqct.js";
import { c as buildSlackBlocksFallbackText, t as sendMessageSlack } from "./send-N1ZXm8DK.js";
import { a as resolveSlackMedia } from "./media-kHQwUTGX.js";
//#region extensions/slack/src/edit-text.ts
function buildSlackEditTextPayload(content, blocks) {
	const trimmedContent = content.trim();
	if (trimmedContent) return trimmedContent;
	if (blocks?.length) return truncateSlackText(buildSlackBlocksFallbackText(blocks), SLACK_TEXT_LIMIT);
	return " ";
}
//#endregion
//#region extensions/slack/src/actions.ts
function resolveToken(explicit, accountId, cfg) {
	if (explicit?.trim()) {
		const token = resolveSlackBotToken(explicit);
		if (token) return token;
	}
	if (!cfg) throw new Error("Slack actions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const account = resolveSlackAccount({
		cfg: requireRuntimeConfig(cfg, "Slack actions"),
		accountId
	});
	const token = resolveSlackBotToken(account.botToken ?? void 0);
	if (!token) {
		logVerbose(`slack actions: missing bot token for account=${account.accountId} explicit=${Boolean(explicit)} source=${account.botTokenSource ?? "unknown"}`);
		throw new Error("SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack actions");
	}
	return token;
}
function normalizeEmoji(raw) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("Emoji is required for Slack reactions");
	return trimmed.replace(/^:+|:+$/g, "");
}
function hasSlackPlatformError(err, code) {
	if (!err || typeof err !== "object") return false;
	const data = err.data;
	if (!data || typeof data !== "object") return false;
	return data.error === code;
}
async function getClient(opts = {}, mode = "read") {
	if (opts.client) return opts.client;
	const token = resolveToken(opts.token, opts.accountId, opts.cfg);
	return mode === "write" ? getSlackWriteClient(token) : createSlackWebClient(token);
}
async function resolveBotUserId(client) {
	const auth = await client.auth.test();
	if (!auth?.user_id) throw new Error("Failed to resolve Slack bot user id");
	return auth.user_id;
}
async function reactSlackMessage(channelId, messageId, emoji, opts = {}) {
	const client = await getClient(opts, "write");
	try {
		await client.reactions.add({
			channel: channelId,
			timestamp: messageId,
			name: normalizeEmoji(emoji)
		});
	} catch (err) {
		if (hasSlackPlatformError(err, "already_reacted")) return;
		throw err;
	}
}
async function removeSlackReaction(channelId, messageId, emoji, opts = {}) {
	const client = await getClient(opts, "write");
	try {
		await client.reactions.remove({
			channel: channelId,
			timestamp: messageId,
			name: normalizeEmoji(emoji)
		});
	} catch (err) {
		if (hasSlackPlatformError(err, "no_reaction")) return;
		throw err;
	}
}
async function removeOwnSlackReactions(channelId, messageId, opts = {}) {
	const client = await getClient(opts, "write");
	const userId = await resolveBotUserId(client);
	const reactions = await listSlackReactions(channelId, messageId, { client });
	const toRemove = /* @__PURE__ */ new Set();
	for (const reaction of reactions ?? []) {
		const name = reaction?.name;
		if (!name) continue;
		if ((reaction?.users ?? []).includes(userId)) toRemove.add(name);
	}
	if (toRemove.size === 0) return [];
	await Promise.all(Array.from(toRemove, (name) => removeSlackReaction(channelId, messageId, name, {
		...opts,
		client
	})));
	return Array.from(toRemove);
}
async function listSlackReactions(channelId, messageId, opts = {}) {
	return (await (await getClient(opts)).reactions.get({
		channel: channelId,
		timestamp: messageId,
		full: true
	})).message?.reactions ?? [];
}
async function sendSlackMessage(to, content, opts) {
	return await sendMessageSlack(to, content, {
		accountId: opts.accountId,
		cfg: opts.cfg,
		token: opts.token,
		mediaUrl: opts.mediaUrl,
		mediaAccess: opts.mediaAccess,
		mediaLocalRoots: opts.mediaLocalRoots,
		mediaReadFile: opts.mediaReadFile,
		client: opts.client,
		threadTs: opts.threadTs,
		replyBroadcast: opts.replyBroadcast,
		...opts.uploadFileName ? { uploadFileName: opts.uploadFileName } : {},
		...opts.uploadTitle ? { uploadTitle: opts.uploadTitle } : {},
		blocks: opts.blocks
	});
}
async function editSlackMessage(channelId, messageId, content, opts = {}) {
	const client = await getClient(opts, "write");
	const blocks = opts.blocks == null ? void 0 : validateSlackBlocksArray(opts.blocks);
	await client.chat.update({
		channel: channelId,
		ts: messageId,
		text: buildSlackEditTextPayload(content, blocks),
		...blocks ? { blocks } : {}
	});
}
async function deleteSlackMessage(channelId, messageId, opts = {}) {
	await (await getClient(opts, "write")).chat.delete({
		channel: channelId,
		ts: messageId
	});
}
async function readSlackMessages(channelId, opts = {}) {
	const client = await getClient(opts);
	const exactMessageId = opts.messageId?.trim();
	const readLimit = exactMessageId ? 1 : opts.limit;
	const exactBounds = exactMessageId ? {
		inclusive: true,
		latest: exactMessageId,
		oldest: void 0
	} : {
		latest: opts.before,
		oldest: opts.after
	};
	if (opts.threadId) {
		const result = await client.conversations.replies({
			channel: channelId,
			ts: opts.threadId,
			limit: readLimit,
			...exactBounds
		});
		return {
			messages: (result.messages ?? []).filter((message) => {
				if (exactMessageId) return message.ts === exactMessageId;
				return message.ts !== opts.threadId;
			}),
			hasMore: exactMessageId ? false : Boolean(result.has_more)
		};
	}
	const result = await client.conversations.history({
		channel: channelId,
		limit: readLimit,
		...exactBounds
	});
	return {
		messages: (result.messages ?? []).filter((message) => !exactMessageId || message.ts === exactMessageId),
		hasMore: exactMessageId ? false : Boolean(result.has_more)
	};
}
async function getSlackMemberInfo(userId, opts = {}) {
	return await (await getClient(opts)).users.info({ user: userId });
}
async function listSlackEmojis(opts = {}) {
	return await (await getClient(opts)).emoji.list();
}
async function pinSlackMessage(channelId, messageId, opts = {}) {
	await (await getClient(opts, "write")).pins.add({
		channel: channelId,
		timestamp: messageId
	});
}
async function unpinSlackMessage(channelId, messageId, opts = {}) {
	await (await getClient(opts, "write")).pins.remove({
		channel: channelId,
		timestamp: messageId
	});
}
async function listSlackPins(channelId, opts = {}) {
	return (await (await getClient(opts)).pins.list({ channel: channelId })).items ?? [];
}
function normalizeSlackScopeValue(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function collectSlackDirectShareChannelIds(file) {
	const ids = /* @__PURE__ */ new Set();
	for (const group of [
		file.channels,
		file.groups,
		file.ims
	]) {
		if (!Array.isArray(group)) continue;
		for (const entry of group) {
			if (typeof entry !== "string") continue;
			const normalized = normalizeSlackScopeValue(entry);
			if (normalized) ids.add(normalized);
		}
	}
	return ids;
}
function collectSlackShareMaps(file) {
	if (!file.shares || typeof file.shares !== "object" || Array.isArray(file.shares)) return [];
	const shares = file.shares;
	return [shares.public, shares.private].filter((value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}
function collectSlackSharedChannelIds(file) {
	const ids = /* @__PURE__ */ new Set();
	for (const shareMap of collectSlackShareMaps(file)) for (const channelId of Object.keys(shareMap)) {
		const normalized = normalizeSlackScopeValue(channelId);
		if (normalized) ids.add(normalized);
	}
	return ids;
}
function collectSlackThreadShares(file, channelId) {
	const matches = [];
	for (const shareMap of collectSlackShareMaps(file)) {
		const rawEntries = shareMap[channelId];
		if (!Array.isArray(rawEntries)) continue;
		for (const rawEntry of rawEntries) {
			if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
			const entry = rawEntry;
			const ts = typeof entry.ts === "string" ? normalizeSlackScopeValue(entry.ts) : void 0;
			const threadTs = typeof entry.thread_ts === "string" ? normalizeSlackScopeValue(entry.thread_ts) : void 0;
			matches.push({
				channelId,
				ts,
				threadTs
			});
		}
	}
	return matches;
}
function hasSlackScopeMismatch(params) {
	const channelId = normalizeSlackScopeValue(params.channelId);
	if (!channelId) return false;
	const threadId = normalizeSlackScopeValue(params.threadId);
	const directIds = collectSlackDirectShareChannelIds(params.file);
	const sharedIds = collectSlackSharedChannelIds(params.file);
	const hasChannelEvidence = directIds.size > 0 || sharedIds.size > 0;
	const inChannel = directIds.has(channelId) || sharedIds.has(channelId);
	if (hasChannelEvidence && !inChannel) return true;
	if (!threadId) return false;
	const threadShares = collectSlackThreadShares(params.file, channelId);
	if (threadShares.length === 0) return false;
	const threadEvidence = threadShares.filter((entry) => entry.threadTs || entry.ts);
	if (threadEvidence.length === 0) return false;
	return !threadEvidence.some((entry) => entry.threadTs === threadId || entry.ts === threadId);
}
/**
* Downloads a Slack file by ID and saves it to the local media store.
* Fetches a fresh download URL via files.info to avoid using stale private URLs.
* Returns null when the file cannot be found or downloaded.
*/
async function downloadSlackFile(fileId, opts) {
	const token = resolveToken(opts.token, opts.accountId, opts.cfg);
	const file = (await (await getClient(opts)).files.info({ file: fileId })).file;
	if (!file?.url_private_download && !file?.url_private) return null;
	if (hasSlackScopeMismatch({
		file,
		channelId: opts.channelId,
		threadId: opts.threadId
	})) return null;
	return (await resolveSlackMedia({
		files: [{
			id: file.id,
			name: file.name,
			mimetype: file.mimetype,
			url_private: file.url_private,
			url_private_download: file.url_private_download
		}],
		token,
		maxBytes: opts.maxBytes
	}))?.[0] ?? null;
}
//#endregion
export { listSlackEmojis as a, pinSlackMessage as c, removeOwnSlackReactions as d, removeSlackReaction as f, buildSlackEditTextPayload as h, getSlackMemberInfo as i, reactSlackMessage as l, unpinSlackMessage as m, downloadSlackFile as n, listSlackPins as o, sendSlackMessage as p, editSlackMessage as r, listSlackReactions as s, deleteSlackMessage as t, readSlackMessages as u };
