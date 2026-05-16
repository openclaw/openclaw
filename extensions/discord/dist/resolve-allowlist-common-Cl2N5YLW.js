import { t as normalizeDiscordToken } from "./token-BZtonk7d.js";
import { n as fetchDiscord } from "./api-DzNBVTto.js";
import { a as normalizeDiscordSlug } from "./allow-list-ek-1hMKN.js";
//#region extensions/discord/src/guilds.ts
async function listGuilds(token, fetcher) {
	return (await fetchDiscord("/users/@me/guilds", token, fetcher)).filter((guild) => typeof guild.id === "string" && typeof guild.name === "string").map((guild) => ({
		id: guild.id,
		name: guild.name,
		slug: normalizeDiscordSlug(guild.name)
	}));
}
//#endregion
//#region extensions/discord/src/resolve-allowlist-common.ts
function resolveDiscordAllowlistToken(token) {
	return normalizeDiscordToken(token, "channels.discord.token");
}
function buildDiscordUnresolvedResults(entries, buildResult) {
	return entries.map((input) => buildResult(input));
}
function findDiscordGuildByName(guilds, input) {
	const slug = normalizeDiscordSlug(input);
	if (!slug) return;
	return guilds.find((guild) => guild.slug === slug);
}
function filterDiscordGuilds(guilds, params) {
	if (params.guildId) return guilds.filter((guild) => guild.id === params.guildId);
	if (params.guildName) {
		const match = findDiscordGuildByName(guilds, params.guildName);
		return match ? [match] : [];
	}
	return guilds;
}
//#endregion
export { listGuilds as i, filterDiscordGuilds as n, resolveDiscordAllowlistToken as r, buildDiscordUnresolvedResults as t };
