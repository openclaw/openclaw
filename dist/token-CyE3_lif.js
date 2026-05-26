import { h as resolveSecretInputString, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { g as selectApplicableRuntimeConfig, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import "./routing-79DRZvfm.js";
import "./secret-input-CWnTb0tw.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
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
	const envToken = accountId === "default" ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
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
