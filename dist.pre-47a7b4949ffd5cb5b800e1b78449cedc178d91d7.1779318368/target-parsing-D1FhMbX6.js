import { a as parseMentionPrefixOrAtUserTarget, l as requireTargetKind, t as buildMessagingTarget } from "./targets-C9_VjGMs.js";
//#region extensions/discord/src/target-parsing.ts
function parseDiscordTarget(raw, options = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const providerPrefixedTarget = parseDiscordProviderPrefixedTarget(trimmed);
	if (providerPrefixedTarget) return providerPrefixedTarget;
	const userTarget = parseMentionPrefixOrAtUserTarget({
		raw: trimmed,
		mentionPattern: /^<@!?(\d+)>$/,
		prefixes: [
			{
				prefix: "user:",
				kind: "user"
			},
			{
				prefix: "channel:",
				kind: "channel"
			},
			{
				prefix: "discord:",
				kind: "user"
			}
		],
		atUserPattern: /^\d+$/,
		atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)"
	});
	if (userTarget) return userTarget;
	if (/^\d+$/.test(trimmed)) {
		if (options.defaultKind) return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
		throw new Error(options.ambiguousMessage ?? `Ambiguous Discord recipient "${trimmed}". For DMs use "user:${trimmed}" or "<@${trimmed}>"; for channels use "channel:${trimmed}".`);
	}
	return buildMessagingTarget("channel", trimmed, trimmed);
}
function parseDiscordProviderPrefixedTarget(raw) {
	const match = /^discord:(channel|user):(.+)$/i.exec(raw);
	if (!match) return;
	const kind = match[1]?.toLowerCase();
	const id = match[2]?.trim();
	if (!kind || !id) return;
	return buildMessagingTarget(kind, id, `${kind}:${id}`);
}
function resolveDiscordChannelId(raw) {
	return requireTargetKind({
		platform: "Discord",
		target: parseDiscordTarget(raw, { defaultKind: "channel" }),
		kind: "channel"
	});
}
//#endregion
export { resolveDiscordChannelId as n, parseDiscordTarget as t };
