import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { n as fetchDiscord } from "./api-DzNBVTto.js";
import { i as listGuilds, n as filterDiscordGuilds, r as resolveDiscordAllowlistToken, t as buildDiscordUnresolvedResults } from "./resolve-allowlist-common-Cl2N5YLW.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/resolve-users.ts
var resolve_users_exports = /* @__PURE__ */ __exportAll({ resolveDiscordUserAllowlist: () => resolveDiscordUserAllowlist });
function parseDiscordUserInput(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const mention = trimmed.match(/^<@!?(\d+)>$/);
	if (mention) return { userId: mention[1] };
	const prefixed = trimmed.match(/^(?:user:|discord:)?(\d+)$/i);
	if (prefixed) return { userId: prefixed[1] };
	const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
	if (split.length >= 2) {
		const guild = split[0]?.trim();
		const user = split.slice(1).join("#").trim();
		if (guild && /^\d+$/.test(guild)) return {
			guildId: guild,
			userName: user
		};
		return {
			guildName: guild,
			userName: user
		};
	}
	return { userName: trimmed.replace(/^@/, "") };
}
function scoreDiscordMember(member, query) {
	const q = normalizeLowercaseStringOrEmpty(query);
	const user = member.user;
	const candidates = [
		user.username,
		user.global_name,
		member.nick ?? void 0
	].map((value) => {
		const normalized = normalizeOptionalString(value);
		return normalized ? normalizeLowercaseStringOrEmpty(normalized) : void 0;
	}).filter(Boolean);
	let score = 0;
	if (candidates.some((value) => value === q)) score += 3;
	if (candidates.some((value) => value?.includes(q))) score += 1;
	if (!user.bot) score += 1;
	return score;
}
async function resolveDiscordUserAllowlist(params) {
	const token = resolveDiscordAllowlistToken(params.token);
	if (!token) return buildDiscordUnresolvedResults(params.entries, (input) => ({
		input,
		resolved: false
	}));
	const fetcher = params.fetcher ?? fetch;
	let guilds = null;
	const getGuilds = async () => {
		if (!guilds) guilds = await listGuilds(token, fetcher);
		return guilds;
	};
	const results = [];
	for (const input of params.entries) {
		const parsed = parseDiscordUserInput(input);
		if (parsed.userId) {
			results.push({
				input,
				resolved: true,
				id: parsed.userId
			});
			continue;
		}
		const query = parsed.userName?.trim();
		if (!query) {
			results.push({
				input,
				resolved: false
			});
			continue;
		}
		const guildList = filterDiscordGuilds(await getGuilds(), {
			guildId: parsed.guildId,
			guildName: parsed.guildName?.trim()
		});
		let best = null;
		let matches = 0;
		for (const guild of guildList) {
			const paramsObj = new URLSearchParams({
				query,
				limit: "25"
			});
			const members = await fetchDiscord(`/guilds/${guild.id}/members/search?${paramsObj.toString()}`, token, fetcher);
			for (const member of members) {
				const score = scoreDiscordMember(member, query);
				if (score === 0) continue;
				matches += 1;
				if (!best || score > best.score) best = {
					member,
					guild,
					score
				};
			}
		}
		if (best) {
			const user = best.member.user;
			const name = normalizeOptionalString(best.member.nick) ?? normalizeOptionalString(user.global_name) ?? normalizeOptionalString(user.username);
			results.push({
				input,
				resolved: true,
				id: user.id,
				name,
				guildId: best.guild.id,
				guildName: best.guild.name,
				note: matches > 1 ? "multiple matches; chose best" : void 0
			});
		} else results.push({
			input,
			resolved: false
		});
	}
	return results;
}
//#endregion
export { resolve_users_exports as n, resolveDiscordUserAllowlist as t };
