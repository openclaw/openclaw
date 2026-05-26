import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { r as createSlackWebClient } from "./client-BY5LT_WB.js";
import { n as resolveSlackAllowlistEntries, t as collectSlackCursorItems } from "./resolve-allowlist-common-B5YoQ3gY.js";
//#region extensions/slack/src/resolve-channels.ts
function parseSlackChannelMention(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
	if (mention) return {
		id: mention[1]?.toUpperCase(),
		name: mention[2]?.trim()
	};
	const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
	if (/^[CG][A-Z0-9]+$/i.test(prefixed)) return { id: prefixed.toUpperCase() };
	const name = prefixed.replace(/^#/, "").trim();
	return name ? { name } : {};
}
async function listSlackChannels(client) {
	return collectSlackCursorItems({
		fetchPage: async (cursor) => await client.conversations.list({
			types: "public_channel,private_channel",
			exclude_archived: false,
			limit: 1e3,
			cursor
		}),
		collectPageItems: (res) => (res.channels ?? []).map((channel) => {
			const id = channel.id?.trim();
			const name = channel.name?.trim();
			if (!id || !name) return null;
			return {
				id,
				name,
				archived: Boolean(channel.is_archived),
				isPrivate: Boolean(channel.is_private)
			};
		}).filter(Boolean)
	});
}
function resolveByName(name, channels) {
	const target = normalizeLowercaseStringOrEmpty(name);
	if (!target) return;
	const matches = channels.filter((channel) => normalizeLowercaseStringOrEmpty(channel.name) === target);
	if (matches.length === 0) return;
	return matches.find((channel) => !channel.archived) ?? matches[0];
}
async function resolveSlackChannelAllowlist(params) {
	const channels = await listSlackChannels(params.client ?? createSlackWebClient(params.token));
	return resolveSlackAllowlistEntries({
		entries: params.entries,
		lookup: channels,
		parseInput: parseSlackChannelMention,
		findById: (lookup, id) => lookup.find((channel) => channel.id === id),
		buildIdResolved: ({ input, parsed, match }) => ({
			input,
			resolved: true,
			id: parsed.id,
			name: match?.name ?? parsed.name,
			archived: match?.archived
		}),
		resolveNonId: ({ input, parsed, lookup }) => {
			if (!parsed.name) return;
			const match = resolveByName(parsed.name, lookup);
			if (!match) return;
			return {
				input,
				resolved: true,
				id: match.id,
				name: match.name,
				archived: match.archived
			};
		},
		buildUnresolved: (input) => ({
			input,
			resolved: false
		})
	});
}
//#endregion
export { resolveSlackChannelAllowlist as t };
