import { isRecord } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/security-contract.ts
const unsupportedSecretRefSurfacePatterns = ["channels.discord.threadBindings.webhookToken", "channels.discord.accounts.*.threadBindings.webhookToken"];
function collectUnsupportedSecretRefConfigCandidates(raw) {
	if (!isRecord(raw)) return [];
	if (!isRecord(raw.channels) || !isRecord(raw.channels.discord)) return [];
	const candidates = [];
	const discord = raw.channels.discord;
	const threadBindings = isRecord(discord.threadBindings) ? discord.threadBindings : null;
	if (threadBindings) candidates.push({
		path: "channels.discord.threadBindings.webhookToken",
		value: threadBindings.webhookToken
	});
	const accounts = isRecord(discord.accounts) ? discord.accounts : null;
	if (!accounts) return candidates;
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!isRecord(account) || !isRecord(account.threadBindings)) continue;
		candidates.push({
			path: `channels.discord.accounts.${accountId}.threadBindings.webhookToken`,
			value: account.threadBindings.webhookToken
		});
	}
	return candidates;
}
//#endregion
export { unsupportedSecretRefSurfacePatterns as n, collectUnsupportedSecretRefConfigCandidates as t };
