import { a as normalizeOptionalAccountId, i as normalizeAccountId$1, r as DEFAULT_ACCOUNT_ID } from "./safe-open-sync-C38eX6uV.js";
import { t as tryReadSecretFileSync } from "./secret-file-CAD9-yp9.js";
//#region src/routing/account-lookup.ts
function resolveAccountEntry(accounts, accountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = accountId.toLowerCase();
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
//#endregion
//#region src/line/accounts.ts
function readFileIfExists(filePath) {
	return tryReadSecretFileSync(filePath, "LINE credential file", { rejectSymlink: true });
}
function resolveToken(params) {
	const { accountId, baseConfig, accountConfig } = params;
	if (accountConfig?.channelAccessToken?.trim()) return {
		token: accountConfig.channelAccessToken.trim(),
		tokenSource: "config"
	};
	const accountFileToken = readFileIfExists(accountConfig?.tokenFile);
	if (accountFileToken) return {
		token: accountFileToken,
		tokenSource: "file"
	};
	if (accountId === "default") {
		if (baseConfig?.channelAccessToken?.trim()) return {
			token: baseConfig.channelAccessToken.trim(),
			tokenSource: "config"
		};
		const baseFileToken = readFileIfExists(baseConfig?.tokenFile);
		if (baseFileToken) return {
			token: baseFileToken,
			tokenSource: "file"
		};
		const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
		if (envToken) return {
			token: envToken,
			tokenSource: "env"
		};
	}
	return {
		token: "",
		tokenSource: "none"
	};
}
function resolveSecret(params) {
	const { accountId, baseConfig, accountConfig } = params;
	if (accountConfig?.channelSecret?.trim()) return accountConfig.channelSecret.trim();
	const accountFileSecret = readFileIfExists(accountConfig?.secretFile);
	if (accountFileSecret) return accountFileSecret;
	if (accountId === "default") {
		if (baseConfig?.channelSecret?.trim()) return baseConfig.channelSecret.trim();
		const baseFileSecret = readFileIfExists(baseConfig?.secretFile);
		if (baseFileSecret) return baseFileSecret;
		const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
		if (envSecret) return envSecret;
	}
	return "";
}
function resolveLineAccount(params) {
	const cfg = params.cfg;
	const accountId = normalizeAccountId$1(params.accountId);
	const lineConfig = cfg.channels?.line;
	const accounts = lineConfig?.accounts;
	const accountConfig = accountId !== "default" ? resolveAccountEntry(accounts, accountId) : void 0;
	const { token, tokenSource } = resolveToken({
		accountId,
		baseConfig: lineConfig,
		accountConfig
	});
	const secret = resolveSecret({
		accountId,
		baseConfig: lineConfig,
		accountConfig
	});
	const { accounts: _ignoredAccounts, defaultAccount: _ignoredDefaultAccount, ...lineBase } = lineConfig ?? {};
	const mergedConfig = {
		...lineBase,
		...accountConfig
	};
	const enabled = accountConfig?.enabled ?? (accountId === "default" ? lineConfig?.enabled ?? true : false);
	return {
		accountId,
		name: accountConfig?.name ?? (accountId === "default" ? lineConfig?.name : void 0),
		enabled,
		channelAccessToken: token,
		channelSecret: secret,
		tokenSource,
		config: mergedConfig
	};
}
function listLineAccountIds(cfg) {
	const lineConfig = cfg.channels?.line;
	const accounts = lineConfig?.accounts;
	const ids = /* @__PURE__ */ new Set();
	if (lineConfig?.channelAccessToken?.trim() || lineConfig?.tokenFile || process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()) ids.add(DEFAULT_ACCOUNT_ID);
	if (accounts) for (const id of Object.keys(accounts)) ids.add(id);
	return Array.from(ids);
}
function resolveDefaultLineAccountId(cfg) {
	const preferred = normalizeOptionalAccountId((cfg.channels?.line)?.defaultAccount);
	if (preferred && listLineAccountIds(cfg).some((accountId) => normalizeAccountId$1(accountId) === preferred)) return preferred;
	const ids = listLineAccountIds(cfg);
	if (ids.includes("default")) return DEFAULT_ACCOUNT_ID;
	return ids[0] ?? "default";
}
function normalizeAccountId(accountId) {
	return normalizeAccountId$1(accountId);
}
//#endregion
export { resolveAccountEntry as a, resolveLineAccount as i, normalizeAccountId as n, resolveDefaultLineAccountId as r, listLineAccountIds as t };
