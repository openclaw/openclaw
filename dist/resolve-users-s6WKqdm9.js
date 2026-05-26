import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { r as createSlackWebClient } from "./client-BY5LT_WB.js";
import { n as resolveSlackAllowlistEntries, t as collectSlackCursorItems } from "./resolve-allowlist-common-B5YoQ3gY.js";
//#region extensions/slack/src/resolve-users.ts
function parseSlackUserInput(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
	if (mention) return { id: mention[1]?.toUpperCase() };
	const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
	if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) return { id: prefixed.toUpperCase() };
	if (trimmed.includes("@") && !trimmed.startsWith("@")) return { email: normalizeLowercaseStringOrEmpty(trimmed) };
	const name = trimmed.replace(/^@/, "").trim();
	return name ? { name } : {};
}
async function listSlackUsers(client) {
	return collectSlackCursorItems({
		fetchPage: async (cursor) => await client.users.list({
			limit: 200,
			cursor
		}),
		collectPageItems: (res) => (res.members ?? []).map((member) => {
			const id = normalizeOptionalString(member.id);
			const name = normalizeOptionalString(member.name);
			if (!id || !name) return null;
			const profile = member.profile ?? {};
			return {
				id,
				name,
				displayName: normalizeOptionalString(profile.display_name),
				realName: normalizeOptionalString(profile.real_name) ?? normalizeOptionalString(member.real_name),
				email: normalizeOptionalString(profile.email) == null ? void 0 : normalizeLowercaseStringOrEmpty(profile.email),
				deleted: Boolean(member.deleted),
				isBot: Boolean(member.is_bot),
				isAppUser: Boolean(member.is_app_user)
			};
		}).filter(Boolean)
	});
}
function scoreSlackUser(user, match) {
	let score = 0;
	if (!user.deleted) score += 3;
	if (!user.isBot && !user.isAppUser) score += 2;
	if (match.email && user.email === match.email) score += 5;
	if (match.name) {
		const target = normalizeLowercaseStringOrEmpty(match.name);
		if ([
			user.name,
			user.displayName,
			user.realName
		].map((value) => normalizeLowercaseStringOrEmpty(value)).filter(Boolean).some((value) => value === target)) score += 2;
	}
	return score;
}
function resolveSlackUserFromMatches(input, matches, parsed) {
	const best = matches.map((user) => ({
		user,
		score: scoreSlackUser(user, parsed)
	})).toSorted((a, b) => b.score - a.score)[0]?.user ?? matches[0];
	return {
		input,
		resolved: true,
		id: best.id,
		name: best.displayName ?? best.realName ?? best.name,
		email: best.email,
		deleted: best.deleted,
		isBot: best.isBot,
		note: matches.length > 1 ? "multiple matches; chose best" : void 0
	};
}
async function resolveSlackUserAllowlist(params) {
	const users = await listSlackUsers(params.client ?? createSlackWebClient(params.token));
	return resolveSlackAllowlistEntries({
		entries: params.entries,
		lookup: users,
		parseInput: parseSlackUserInput,
		findById: (lookup, id) => lookup.find((user) => user.id === id),
		buildIdResolved: ({ input, parsed, match }) => ({
			input,
			resolved: true,
			id: parsed.id,
			name: match?.displayName ?? match?.realName ?? match?.name,
			email: match?.email,
			deleted: match?.deleted,
			isBot: match?.isBot
		}),
		resolveNonId: ({ input, parsed, lookup }) => {
			if (parsed.email) {
				const matches = lookup.filter((user) => user.email === parsed.email);
				if (matches.length > 0) return resolveSlackUserFromMatches(input, matches, parsed);
			}
			if (parsed.name) {
				const target = normalizeLowercaseStringOrEmpty(parsed.name);
				const matches = lookup.filter((user) => {
					return [
						user.name,
						user.displayName,
						user.realName
					].map((value) => normalizeLowercaseStringOrEmpty(value)).filter(Boolean).includes(target);
				});
				if (matches.length > 0) return resolveSlackUserFromMatches(input, matches, parsed);
			}
		},
		buildUnresolved: (input) => ({
			input,
			resolved: false
		})
	});
}
//#endregion
export { resolveSlackUserAllowlist as t };
