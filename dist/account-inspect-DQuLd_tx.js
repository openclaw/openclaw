import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as normalizeSecretInputString, s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import { a as mergeDiscordAccountConfig, l as resolveDiscordAccountConfig, o as resolveDefaultDiscordAccountId } from "./accounts-DIRzXd2H.js";
//#region extensions/discord/src/account-inspect.ts
function inspectDiscordTokenValue(value) {
	const normalized = normalizeSecretInputString(value);
	if (normalized) return {
		token: normalized.replace(/^Bot\s+/i, ""),
		tokenSource: "config",
		tokenStatus: "available"
	};
	if (hasConfiguredSecretInput(value)) return {
		token: "",
		tokenSource: "config",
		tokenStatus: "configured_unavailable"
	};
	return null;
}
function inspectDiscordAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(params.cfg));
	const merged = mergeDiscordAccountConfig(params.cfg, accountId);
	const enabled = params.cfg.channels?.discord?.enabled !== false && merged.enabled !== false;
	const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
	const hasAccountToken = Boolean(accountConfig && Object.prototype.hasOwnProperty.call(accountConfig, "token"));
	const accountToken = inspectDiscordTokenValue(accountConfig?.token);
	if (accountToken) return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: accountToken.token,
		tokenSource: accountToken.tokenSource,
		tokenStatus: accountToken.tokenStatus,
		configured: true,
		config: merged
	};
	if (hasAccountToken) return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: "",
		tokenSource: "none",
		tokenStatus: "missing",
		configured: false,
		config: merged
	};
	const channelToken = inspectDiscordTokenValue(params.cfg.channels?.discord?.token);
	if (channelToken) return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: channelToken.token,
		tokenSource: channelToken.tokenSource,
		tokenStatus: channelToken.tokenStatus,
		configured: true,
		config: merged
	};
	const envToken = accountId === "default" ? normalizeSecretInputString(params.envToken ?? process.env.DISCORD_BOT_TOKEN) : void 0;
	if (envToken) return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: envToken.replace(/^Bot\s+/i, ""),
		tokenSource: "env",
		tokenStatus: "available",
		configured: true,
		config: merged
	};
	return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: "",
		tokenSource: "none",
		tokenStatus: "missing",
		configured: false,
		config: merged
	};
}
//#endregion
export { inspectDiscordAccount as t };
