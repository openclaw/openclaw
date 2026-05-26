import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { a as resolveSlackAccount } from "./accounts-Ba1LnRZV.js";
import { r as createSlackWebClient } from "./client-BY5LT_WB.js";
//#region extensions/slack/src/directory-live.ts
function resolveReadToken(params) {
	const account = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return account.userToken ?? account.botToken?.trim();
}
function normalizeQuery(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function buildUserRank(user) {
	let rank = 0;
	if (!user.deleted) rank += 2;
	if (!user.is_bot && !user.is_app_user) rank += 1;
	return rank;
}
function buildChannelRank(channel) {
	return channel.is_archived ? 0 : 1;
}
function slackUserToDirectoryEntry(user, fallback) {
	const id = normalizeOptionalString(user.id) ?? normalizeOptionalString(fallback?.id);
	if (!id) return null;
	const handle = normalizeOptionalString(user.name) ?? normalizeOptionalString(fallback?.name);
	const display = normalizeOptionalString(user.profile?.display_name) || normalizeOptionalString(user.profile?.real_name) || normalizeOptionalString(user.real_name) || handle;
	return {
		kind: "user",
		id: `user:${id}`,
		name: display || void 0,
		handle: handle ? `@${handle}` : void 0,
		rank: buildUserRank(user),
		raw: user
	};
}
async function getSlackDirectorySelfLive(params) {
	const token = resolveReadToken(params);
	if (!token) return null;
	const client = createSlackWebClient(token);
	const auth = await client.auth.test();
	const userId = normalizeOptionalString(auth.user_id);
	if (!userId) return null;
	try {
		return slackUserToDirectoryEntry((await client.users.info({ user: userId })).user ?? {}, {
			id: userId,
			name: auth.user
		});
	} catch {
		return slackUserToDirectoryEntry({
			id: userId,
			name: auth.user
		}, {
			id: userId,
			name: auth.user
		});
	}
}
async function listSlackDirectoryPeersLive(params) {
	const token = resolveReadToken(params);
	if (!token) return [];
	const client = createSlackWebClient(token);
	const query = normalizeQuery(params.query);
	const members = [];
	let cursor;
	do {
		const res = await client.users.list({
			limit: 200,
			cursor
		});
		if (Array.isArray(res.members)) members.push(...res.members);
		const next = res.response_metadata?.next_cursor?.trim();
		cursor = next ? next : void 0;
	} while (cursor);
	const rows = members.filter((member) => {
		const candidates = [
			member.profile?.display_name || member.profile?.real_name || member.real_name,
			member.name,
			member.profile?.email
		].map((item) => normalizeOptionalLowercaseString(item)).filter(Boolean);
		if (!query) return true;
		return candidates.some((candidate) => candidate?.includes(query));
	}).map((member) => slackUserToDirectoryEntry(member)).filter(Boolean);
	if (typeof params.limit === "number" && params.limit > 0) return rows.slice(0, params.limit);
	return rows;
}
async function listSlackDirectoryGroupsLive(params) {
	const token = resolveReadToken(params);
	if (!token) return [];
	const client = createSlackWebClient(token);
	const query = normalizeQuery(params.query);
	const channels = [];
	let cursor;
	do {
		const res = await client.conversations.list({
			types: "public_channel,private_channel",
			exclude_archived: false,
			limit: 1e3,
			cursor
		});
		if (Array.isArray(res.channels)) channels.push(...res.channels);
		const next = res.response_metadata?.next_cursor?.trim();
		cursor = next ? next : void 0;
	} while (cursor);
	const rows = channels.filter((channel) => {
		const name = normalizeOptionalLowercaseString(channel.name);
		if (!query) return true;
		return Boolean(name && name.includes(query));
	}).map((channel) => {
		const id = channel.id?.trim();
		const name = channel.name?.trim();
		if (!id || !name) return null;
		return {
			kind: "group",
			id: `channel:${id}`,
			name,
			handle: `#${name}`,
			rank: buildChannelRank(channel),
			raw: channel
		};
	}).filter(Boolean);
	if (typeof params.limit === "number" && params.limit > 0) return rows.slice(0, params.limit);
	return rows;
}
//#endregion
export { listSlackDirectoryGroupsLive as n, listSlackDirectoryPeersLive as r, getSlackDirectorySelfLive as t };
