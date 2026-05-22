import { t as buildMessagingTarget } from "./targets-CC-kPkLd.js";
import { c as resolveDiscordAccountAllowFrom, s as resolveDiscordAccount } from "./accounts-C4zYLC5-.js";
import { t as parseDiscordTarget } from "./target-parsing-CE3M5DI7.js";
import { t as rememberDiscordDirectoryUser } from "./directory-cache-BhmqkKl8.js";
import { n as listDiscordDirectoryPeersLive } from "./directory-live-cPpnhEZO.js";
import { t as allowFromContainsDiscordUserId } from "./normalize-CRtlgnsR.js";
//#region extensions/discord/src/send-target-parsing.ts
const parseDiscordSendTarget = (raw, options = {}) => parseDiscordTarget(raw, options);
//#endregion
//#region extensions/discord/src/target-resolver.ts
/**
* Resolve a Discord username to user ID using the directory lookup.
* This enables sending DMs by username instead of requiring explicit user IDs.
*/
async function resolveDiscordTarget(raw, options, parseOptions = {}) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const likelyUsername = isLikelyUsername(trimmed);
	const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
	if (/^\d+$/.test(trimmed) && parseOptions.defaultKind !== "user" && isConfiguredAllowedDiscordDmUser(trimmed, options)) return buildMessagingTarget("user", trimmed, trimmed);
	const directParse = safeParseDiscordTarget(trimmed, parseOptions);
	if (directParse && directParse.kind !== "channel" && !likelyUsername) return directParse;
	if (!shouldLookup) return directParse ?? parseDiscordSendTarget(trimmed, parseOptions);
	try {
		const match = (await listDiscordDirectoryPeersLive({
			...options,
			query: trimmed,
			limit: 1
		}))[0];
		if (match && match.kind === "user") {
			const userId = match.id.replace(/^user:/, "");
			const resolvedAccountId = resolveDiscordAccount({
				cfg: options.cfg,
				accountId: options.accountId
			}).accountId;
			rememberDiscordDirectoryUser({
				accountId: resolvedAccountId,
				userId,
				handles: [
					trimmed,
					match.name,
					match.handle
				]
			});
			return buildMessagingTarget("user", userId, trimmed);
		}
	} catch {}
	return parseDiscordSendTarget(trimmed, parseOptions);
}
async function parseAndResolveDiscordTarget(raw, options, parseOptions = {}) {
	const resolved = await resolveDiscordTarget(raw, options, parseOptions) ?? parseDiscordSendTarget(raw, parseOptions);
	if (!resolved) throw new Error("Recipient is required for Discord sends");
	return resolved;
}
function safeParseDiscordTarget(input, options) {
	try {
		return parseDiscordSendTarget(input, options);
	} catch {
		return;
	}
}
function isConfiguredAllowedDiscordDmUser(input, options) {
	return allowFromContainsDiscordUserId(resolveDiscordAccountAllowFrom({
		cfg: options.cfg,
		accountId: options.accountId
	}) ?? [], input);
}
function isExplicitUserLookup(input, options) {
	if (/^<@!?(\d+)>$/.test(input)) return true;
	if (/^(user:|discord:)/.test(input)) return true;
	if (input.startsWith("@")) return true;
	if (/^\d+$/.test(input)) return options.defaultKind === "user";
	return false;
}
function isLikelyUsername(input) {
	if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) return false;
	return true;
}
//#endregion
export { resolveDiscordTarget as n, parseDiscordSendTarget as r, parseAndResolveDiscordTarget as t };
