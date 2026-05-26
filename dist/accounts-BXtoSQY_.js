import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { c as isSecretRef } from "./types.secrets-BxqheYvy.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { n as safeParseWithSchema, t as safeParseJsonWithSchema } from "./zod-parse-7tICWiqC.js";
import { t as resolveAccountEntry } from "./account-lookup-DAEppsQ5.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { s as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-Ba4hZbOH.js";
import "./secret-input-DlbCRffO.js";
import "./account-resolution-CpfIEmNk.js";
import "./extension-shared-BznPIa-o.js";
import { z } from "zod";
//#region extensions/googlechat/src/accounts.ts
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const JsonRecordSchema = z.record(z.string(), z.unknown());
const { listAccountIds: listGoogleChatAccountIds, resolveDefaultAccountId: resolveDefaultGoogleChatAccountId } = createAccountListHelpers("googlechat");
function mergeGoogleChatAccountConfig(cfg, accountId) {
	const raw = cfg.channels?.["googlechat"] ?? {};
	const base = resolveMergedAccountConfig({
		channelConfig: raw,
		accounts: raw.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
	const defaultAccountConfig = resolveAccountEntry(raw.accounts, "default") ?? {};
	if (accountId === "default") return base;
	const { enabled: _ignoredEnabled, dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching, serviceAccount: _ignoredServiceAccount, serviceAccountRef: _ignoredServiceAccountRef, serviceAccountFile: _ignoredServiceAccountFile, ...defaultAccountShared } = defaultAccountConfig;
	return {
		...defaultAccountShared,
		...base
	};
}
function resolveGoogleChatConfigAccessorAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? params.cfg.channels?.googlechat?.defaultAccount);
	return { config: mergeGoogleChatAccountConfig(params.cfg, accountId) };
}
function parseServiceAccount(value) {
	if (isSecretRef(value)) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		return safeParseJsonWithSchema(JsonRecordSchema, trimmed);
	}
	return safeParseWithSchema(JsonRecordSchema, value);
}
function resolveCredentialsFromConfig(params) {
	const { account, accountId } = params;
	const inline = parseServiceAccount(account.serviceAccount);
	if (inline) return {
		credentials: inline,
		source: "inline"
	};
	if (isSecretRef(account.serviceAccount)) throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);
	if (isSecretRef(account.serviceAccountRef)) throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);
	const file = normalizeOptionalString(account.serviceAccountFile);
	if (file) return {
		credentialsFile: file,
		source: "file"
	};
	if (accountId === "default") {
		const envJson = process.env[ENV_SERVICE_ACCOUNT];
		const envInline = parseServiceAccount(envJson);
		if (envInline) return {
			credentials: envInline,
			source: "env"
		};
		const envFile = normalizeOptionalString(process.env[ENV_SERVICE_ACCOUNT_FILE]);
		if (envFile) return {
			credentialsFile: envFile,
			source: "env"
		};
	}
	return { source: "none" };
}
function resolveGoogleChatAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? params.cfg.channels?.["googlechat"]?.defaultAccount);
	const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
	const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const credentials = resolveCredentialsFromConfig({
		accountId,
		account: merged
	});
	return {
		accountId,
		name: normalizeOptionalString(merged.name),
		enabled,
		config: merged,
		credentialSource: credentials.source,
		credentials: credentials.credentials,
		credentialsFile: credentials.credentialsFile
	};
}
function listEnabledGoogleChatAccounts(cfg) {
	return listGoogleChatAccountIds(cfg).map((accountId) => resolveGoogleChatAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
export { resolveGoogleChatConfigAccessorAccount as a, resolveGoogleChatAccount as i, listGoogleChatAccountIds as n, resolveDefaultGoogleChatAccountId as r, listEnabledGoogleChatAccounts as t };
