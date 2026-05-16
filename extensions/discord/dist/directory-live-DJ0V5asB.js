import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { t as normalizeDiscordToken } from "./token-BZtonk7d.js";
import { s as resolveDiscordAccount } from "./accounts-CaHGiVB4.js";
import { t as rememberDiscordDirectoryUser } from "./directory-cache-D93eSrpB.js";
import { n as fetchDiscord } from "./api-DzNBVTto.js";
import { a as normalizeDiscordSlug } from "./allow-list-ek-1hMKN.js";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/directory-live.ts
var directory_live_exports = /* @__PURE__ */ __exportAll({
	listDiscordDirectoryGroupsLive: () => listDiscordDirectoryGroupsLive,
	listDiscordDirectoryPeersLive: () => listDiscordDirectoryPeersLive
});
function normalizeQuery(value) {
	return normalizeOptionalLowercaseString(value) ?? "";
}
function buildUserRank(user) {
	return user.bot ? 0 : 1;
}
function resolveDiscordDirectoryAccess(params) {
	const account = resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const token = normalizeDiscordToken(account.token, "channels.discord.token");
	if (!token) return null;
	return {
		token,
		query: normalizeQuery(params.query),
		accountId: account.accountId
	};
}
async function listDiscordGuilds(token) {
	return (await fetchDiscord("/users/@me/guilds", token)).filter((guild) => guild.id && guild.name);
}
async function listDiscordDirectoryGroupsLive(params) {
	const access = resolveDiscordDirectoryAccess(params);
	if (!access) return [];
	const { token, query } = access;
	const guilds = await listDiscordGuilds(token);
	const rows = [];
	for (const guild of guilds) {
		const channels = await fetchDiscord(`/guilds/${guild.id}/channels`, token);
		for (const channel of channels) {
			const name = channel.name?.trim();
			if (!name) continue;
			if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) continue;
			rows.push({
				kind: "group",
				id: `channel:${channel.id}`,
				name,
				handle: `#${name}`,
				raw: channel
			});
			if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) return rows;
		}
	}
	return rows;
}
async function listDiscordDirectoryPeersLive(params) {
	const access = resolveDiscordDirectoryAccess(params);
	if (!access) return [];
	const { token, query, accountId } = access;
	if (!query) return [];
	const guilds = await listDiscordGuilds(token);
	const rows = [];
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;
	for (const guild of guilds) {
		const paramsObj = new URLSearchParams({
			query,
			limit: String(Math.min(limit, 100))
		});
		const members = await fetchDiscord(`/guilds/${guild.id}/members/search?${paramsObj.toString()}`, token);
		for (const member of members) {
			const user = member.user;
			if (!user?.id) continue;
			rememberDiscordDirectoryUser({
				accountId,
				userId: user.id,
				handles: [
					user.username,
					user.global_name,
					member.nick,
					user.username ? `@${user.username}` : null
				]
			});
			const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
			rows.push({
				kind: "user",
				id: `user:${user.id}`,
				name: name || void 0,
				handle: user.username ? `@${user.username}` : void 0,
				rank: buildUserRank(user),
				raw: member
			});
			if (rows.length >= limit) return rows;
		}
	}
	return rows;
}
//#endregion
export { listDiscordDirectoryGroupsLive as n, listDiscordDirectoryPeersLive as r, directory_live_exports as t };
