import { l as normalizeResolvedSecretInputString } from "./types.secrets-CyuYZNvB.js";
import { n as normalizeAccountId } from "./account-id-fkYplFFW.js";
import { t as resolveAccountEntry } from "./account-lookup-BtBP9pcu.js";
import "./routing-mgXN0NdW.js";
import "./secret-input-CBwDj35T.js";
//#region extensions/discord/src/token.ts
function normalizeDiscordToken(raw, path) {
	const trimmed = normalizeResolvedSecretInputString({
		value: raw,
		path
	});
	if (!trimmed) return;
	return trimmed.replace(/^Bot\s+/i, "");
}
function resolveDiscordToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const discordCfg = cfg?.channels?.discord;
	const accountCfg = resolveAccountEntry(discordCfg?.accounts, accountId);
	const hasAccountToken = Boolean(accountCfg && Object.prototype.hasOwnProperty.call(accountCfg, "token"));
	const accountToken = normalizeDiscordToken(accountCfg?.token ?? void 0, `channels.discord.accounts.${accountId}.token`);
	if (accountToken) return {
		token: accountToken,
		source: "config"
	};
	if (hasAccountToken) return {
		token: "",
		source: "none"
	};
	const configToken = normalizeDiscordToken(discordCfg?.token ?? void 0, "channels.discord.token");
	if (configToken) return {
		token: configToken,
		source: "config"
	};
	const envToken = accountId === "default" ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
	if (envToken) return {
		token: envToken,
		source: "env"
	};
	return {
		token: "",
		source: "none"
	};
}
//#endregion
export { resolveDiscordToken as n, normalizeDiscordToken as t };
