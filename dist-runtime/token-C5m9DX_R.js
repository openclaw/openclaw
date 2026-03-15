import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-CYKfwqh7.js";
import { c as normalizeResolvedSecretInputString } from "./types.secrets-CgNgVfYE.js";
import { r as tryReadSecretFileSync } from "./secret-file-Bd-d3WTG.js";
//#region extensions/telegram/src/token.ts
function resolveTelegramToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const telegramCfg = cfg?.channels?.telegram;
	const resolveAccountCfg = (id) => {
		const accounts = telegramCfg?.accounts;
		if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {return;}
		const direct = accounts[id];
		if (direct) {return direct;}
		const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === id);
		return matchKey ? accounts[matchKey] : void 0;
	};
	const accountCfg = resolveAccountCfg(accountId !== "default" ? accountId : DEFAULT_ACCOUNT_ID);
	const accountTokenFile = accountCfg?.tokenFile?.trim();
	if (accountTokenFile) {
		const token = tryReadSecretFileSync(accountTokenFile, `channels.telegram.accounts.${accountId}.tokenFile`, { rejectSymlink: true });
		if (token) {return {
			token,
			source: "tokenFile"
		};}
		opts.logMissingFile?.(`channels.telegram.accounts.${accountId}.tokenFile not found or unreadable: ${accountTokenFile}`);
		return {
			token: "",
			source: "none"
		};
	}
	const accountToken = normalizeResolvedSecretInputString({
		value: accountCfg?.botToken,
		path: `channels.telegram.accounts.${accountId}.botToken`
	});
	if (accountToken) {return {
		token: accountToken,
		source: "config"
	};}
	const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
	const tokenFile = telegramCfg?.tokenFile?.trim();
	if (tokenFile) {
		const token = tryReadSecretFileSync(tokenFile, "channels.telegram.tokenFile", { rejectSymlink: true });
		if (token) {return {
			token,
			source: "tokenFile"
		};}
		opts.logMissingFile?.(`channels.telegram.tokenFile not found or unreadable: ${tokenFile}`);
		return {
			token: "",
			source: "none"
		};
	}
	const configToken = normalizeResolvedSecretInputString({
		value: telegramCfg?.botToken,
		path: "channels.telegram.botToken"
	});
	if (configToken) {return {
		token: configToken,
		source: "config"
	};}
	const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
	if (envToken) {return {
		token: envToken,
		source: "env"
	};}
	return {
		token: "",
		source: "none"
	};
}
//#endregion
export { resolveTelegramToken as t };
