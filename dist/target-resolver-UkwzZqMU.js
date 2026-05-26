import { t as buildMessagingTarget } from "./targets-C9_VjGMs.js";
import { c as resolveDiscordAccountAllowFrom, s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { t as parseDiscordTarget } from "./target-parsing-D1FhMbX6.js";
import { t as rememberDiscordDirectoryUser } from "./directory-cache-BXl54G0d.js";
import { n as listDiscordDirectoryPeersLive } from "./directory-live-BT-NMk8p.js";
import { t as allowFromContainsDiscordUserId } from "./normalize-CECmG1sg.js";
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
