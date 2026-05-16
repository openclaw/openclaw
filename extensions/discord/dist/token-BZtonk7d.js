import { normalizeResolvedSecretInputString, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, selectApplicableRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
//#region extensions/discord/src/runtime-config.ts
function selectDiscordRuntimeConfig(inputConfig) {
	return selectApplicableRuntimeConfig({
		inputConfig,
		runtimeConfig: getRuntimeConfigSnapshot(),
		runtimeSourceConfig: getRuntimeConfigSourceSnapshot()
	}) ?? inputConfig;
}
//#endregion
//#region extensions/discord/src/token.ts
function stripDiscordBotPrefix(token) {
	return token.replace(/^Bot\s+/i, "");
}
function normalizeDiscordToken(raw, path) {
	const trimmed = normalizeResolvedSecretInputString({
		value: raw,
		path
	});
	if (!trimmed) return;
	return stripDiscordBotPrefix(trimmed);
}
function resolveDiscordTokenValue(params) {
	const resolved = resolveSecretInputString({
		value: params.value,
		path: params.path,
		defaults: params.cfg.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status === "available") return {
		status: "available",
		value: stripDiscordBotPrefix(resolved.value)
	};
	if (resolved.status === "configured_unavailable") return { status: "configured_unavailable" };
	return { status: "missing" };
}
function resolveDiscordToken(cfg, opts = {}) {
	const selectedCfg = selectDiscordRuntimeConfig(cfg);
	const accountId = normalizeAccountId(opts.accountId);
	const discordCfg = selectedCfg?.channels?.discord;
	const accountCfg = resolveAccountEntry(discordCfg?.accounts, accountId);
	const hasAccountToken = Boolean(accountCfg && Object.prototype.hasOwnProperty.call(accountCfg, "token"));
	const accountToken = resolveDiscordTokenValue({
		cfg: selectedCfg,
		value: accountCfg?.token,
		path: `channels.discord.accounts.${accountId}.token`
	});
	if (accountToken.status === "available" && accountToken.value) return {
		token: accountToken.value,
		source: "config",
		tokenStatus: "available"
	};
	if (accountToken.status === "configured_unavailable") return {
		token: "",
		source: "config",
		tokenStatus: "configured_unavailable"
	};
	if (hasAccountToken) return {
		token: "",
		source: "none",
		tokenStatus: "missing"
	};
	const configToken = resolveDiscordTokenValue({
		cfg: selectedCfg,
		value: discordCfg?.token,
		path: "channels.discord.token"
	});
	if (configToken.status === "available" && configToken.value) return {
		token: configToken.value,
		source: "config",
		tokenStatus: "available"
	};
	if (configToken.status === "configured_unavailable") return {
		token: "",
		source: "config",
		tokenStatus: "configured_unavailable"
	};
	const envToken = accountId === DEFAULT_ACCOUNT_ID ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
	if (envToken) return {
		token: envToken,
		source: "env",
		tokenStatus: "available"
	};
	return {
		token: "",
		source: "none",
		tokenStatus: "missing"
	};
}
//#endregion
export { resolveDiscordToken as n, selectDiscordRuntimeConfig as r, normalizeDiscordToken as t };
