import { d as normalizeSecretInputString, h as resolveSecretInputString } from "./types.secrets-BxqheYvy.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { a as tryReadSecretFileSync } from "./secret-file-DOoC_YK8.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-BLk8mcqQ.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-DAEppsQ5.js";
import "./provider-auth-D5QGE8z6.js";
import "./account-core-CNS9JTro.js";
import "./channel-core-BoAjH-Jl.js";
import "./routing-BfSZVtOk.js";
import "./secret-input-DlbCRffO.js";
//#region extensions/telegram/src/token.ts
function resolveEnvSecretRefValue(params) {
	const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
	if (providerConfig) {
		if (providerConfig.source !== "env") throw new Error(`Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "env".`);
		if (providerConfig.allowlist && !providerConfig.allowlist.includes(params.id)) throw new Error(`Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`);
	} else if (params.provider !== resolveDefaultSecretProviderAlias({ secrets: params.cfg?.secrets }, "env")) throw new Error(`Secret provider "${params.provider}" is not configured (ref: env:${params.provider}:${params.id}).`);
	return normalizeSecretInputString((params.env ?? process.env)[params.id]);
}
function resolveRuntimeTokenValue(params) {
	const resolved = resolveSecretInputString({
		value: params.value,
		path: params.path,
		defaults: params.cfg?.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status === "available") return {
		status: "available",
		value: resolved.value
	};
	if (resolved.status === "missing") return { status: "missing" };
	if (resolved.ref.source === "env") {
		const envValue = resolveEnvSecretRefValue({
			cfg: params.cfg,
			provider: resolved.ref.provider,
			id: resolved.ref.id
		});
		if (envValue) return {
			status: "available",
			value: envValue
		};
		return { status: "configured_unavailable" };
	}
	resolveSecretInputString({
		value: params.value,
		path: params.path,
		defaults: params.cfg?.secrets?.defaults,
		mode: "strict"
	});
	return { status: "configured_unavailable" };
}
function resolveTelegramToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const telegramCfg = cfg?.channels?.telegram;
	const resolveAccountCfg = (id) => {
		const accounts = telegramCfg?.accounts;
		return Array.isArray(accounts) ? void 0 : resolveNormalizedAccountEntry(accounts, id, normalizeAccountId);
	};
	const accountCfg = resolveAccountCfg(accountId !== "default" ? accountId : DEFAULT_ACCOUNT_ID);
	if (accountId !== "default" && !accountCfg) {
		const accounts = telegramCfg?.accounts;
		if (!!accounts && typeof accounts === "object" && !Array.isArray(accounts) && Object.keys(accounts).length > 0) {
			opts.logMissingFile?.(`channels.telegram.accounts: unknown accountId "${accountId}" — not found in config, refusing channel-level fallback`);
			return {
				token: "",
				source: "none"
			};
		}
	}
	const accountTokenFile = accountCfg?.tokenFile?.trim();
	if (accountTokenFile) {
		const token = tryReadSecretFileSync(accountTokenFile, `channels.telegram.accounts.${accountId}.tokenFile`, { rejectSymlink: true });
		if (token) return {
			token,
			source: "tokenFile"
		};
		opts.logMissingFile?.(`channels.telegram.accounts.${accountId}.tokenFile not found or unreadable: ${accountTokenFile}`);
		return {
			token: "",
			source: "none"
		};
	}
	const accountToken = resolveRuntimeTokenValue({
		cfg,
		value: accountCfg?.botToken,
		path: `channels.telegram.accounts.${accountId}.botToken`
	});
	if (accountToken.status === "available") return {
		token: accountToken.value,
		source: "config"
	};
	if (accountToken.status === "configured_unavailable") return {
		token: "",
		source: "none"
	};
	const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
	const tokenFile = telegramCfg?.tokenFile?.trim();
	if (tokenFile) {
		const token = tryReadSecretFileSync(tokenFile, "channels.telegram.tokenFile", { rejectSymlink: true });
		if (token) return {
			token,
			source: "tokenFile"
		};
		opts.logMissingFile?.(`channels.telegram.tokenFile not found or unreadable: ${tokenFile}`);
		return {
			token: "",
			source: "none"
		};
	}
	const configToken = resolveRuntimeTokenValue({
		cfg,
		value: telegramCfg?.botToken,
		path: "channels.telegram.botToken"
	});
	if (configToken.status === "available") return {
		token: configToken.value,
		source: "config"
	};
	if (configToken.status === "configured_unavailable") return {
		token: "",
		source: "none"
	};
	const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
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
export { resolveTelegramToken as t };
