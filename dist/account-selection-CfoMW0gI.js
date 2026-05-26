import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-CQEoGO1F.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as listCombinedAccountIds, s as resolveListedDefaultAccountId } from "./account-helpers-BEXOONiv.js";
import { t as listConfiguredAccountIds } from "./account-configured-ids-C2qgDow6.js";
import "./account-core-DdyIQODw.js";
import "./secret-input-runtime-BxNajKSO.js";
import { n as listMatrixEnvAccountIds, t as getMatrixScopedEnvVarNames } from "./env-vars-J2eHsfqp.js";
import "./record-shared-DQ4sTnau.js";
//#region extensions/matrix/src/auth-precedence.ts
const MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS = new Set([
	"userId",
	"accessToken",
	"password",
	"deviceId"
]);
function resolveMatrixStringSourceValue(value) {
	return typeof value === "string" ? value : "";
}
function shouldAllowBaseAuthFallback(accountId, field) {
	return normalizeAccountId(accountId) === "default" || !MATRIX_DEFAULT_ACCOUNT_AUTH_ONLY_FIELDS.has(field);
}
function resolveMatrixAccountStringValues(params) {
	const fields = [
		"homeserver",
		"userId",
		"accessToken",
		"password",
		"deviceId",
		"deviceName"
	];
	const resolved = {};
	for (const field of fields) resolved[field] = resolveMatrixStringSourceValue(params.account?.[field]) || resolveMatrixStringSourceValue(params.scopedEnv?.[field]) || (shouldAllowBaseAuthFallback(params.accountId, field) ? resolveMatrixStringSourceValue(params.channel?.[field]) || resolveMatrixStringSourceValue(params.globalEnv?.[field]) : "");
	return resolved;
}
//#endregion
//#region extensions/matrix/src/account-selection.ts
function readConfiguredMatrixString(value) {
	return normalizeOptionalString(value) ?? "";
}
function readConfiguredMatrixSecretSource(value) {
	return hasConfiguredSecretInput(value) ? "configured" : "";
}
function resolveMatrixChannelStringSources(entry) {
	if (!entry) return {};
	return {
		homeserver: readConfiguredMatrixString(entry.homeserver),
		userId: readConfiguredMatrixString(entry.userId),
		accessToken: readConfiguredMatrixSecretSource(entry.accessToken),
		password: readConfiguredMatrixSecretSource(entry.password),
		deviceId: readConfiguredMatrixString(entry.deviceId),
		deviceName: readConfiguredMatrixString(entry.deviceName)
	};
}
function readEnvMatrixString(env, key) {
	return normalizeOptionalString(env[key]) ?? "";
}
function resolveScopedMatrixEnvStringSources(accountId, env) {
	const keys = getMatrixScopedEnvVarNames(accountId);
	return {
		homeserver: readEnvMatrixString(env, keys.homeserver),
		userId: readEnvMatrixString(env, keys.userId),
		accessToken: readEnvMatrixString(env, keys.accessToken),
		password: readEnvMatrixString(env, keys.password),
		deviceId: readEnvMatrixString(env, keys.deviceId),
		deviceName: readEnvMatrixString(env, keys.deviceName)
	};
}
function resolveGlobalMatrixEnvStringSources(env) {
	return {
		homeserver: readEnvMatrixString(env, "MATRIX_HOMESERVER"),
		userId: readEnvMatrixString(env, "MATRIX_USER_ID"),
		accessToken: readEnvMatrixString(env, "MATRIX_ACCESS_TOKEN"),
		password: readEnvMatrixString(env, "MATRIX_PASSWORD"),
		deviceId: readEnvMatrixString(env, "MATRIX_DEVICE_ID"),
		deviceName: readEnvMatrixString(env, "MATRIX_DEVICE_NAME")
	};
}
function hasUsableResolvedMatrixAuth(values) {
	return Boolean(values.homeserver && (values.accessToken || values.userId));
}
function hasFreshResolvedMatrixAuth(values) {
	return Boolean(values.homeserver && (values.accessToken || values.userId && values.password));
}
function resolveEffectiveMatrixAccountSources(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	return resolveMatrixAccountStringValues({
		accountId: normalizedAccountId,
		scopedEnv: resolveScopedMatrixEnvStringSources(normalizedAccountId, params.env),
		channel: resolveMatrixChannelStringSources(params.channel),
		globalEnv: resolveGlobalMatrixEnvStringSources(params.env)
	});
}
function hasUsableEffectiveMatrixAccountSource(params) {
	return hasUsableResolvedMatrixAuth(resolveEffectiveMatrixAccountSources(params));
}
function hasFreshEffectiveMatrixAccountSource(params) {
	return hasFreshResolvedMatrixAuth(resolveEffectiveMatrixAccountSources(params));
}
function hasConfiguredDefaultMatrixAccountSource(params) {
	return hasFreshEffectiveMatrixAccountSource({
		channel: params.channel,
		accountId: DEFAULT_ACCOUNT_ID,
		env: params.env
	});
}
function resolveMatrixChannelConfig(cfg) {
	return isRecord(cfg.channels?.matrix) ? cfg.channels.matrix : null;
}
function findMatrixAccountEntry(cfg, accountId) {
	const channel = resolveMatrixChannelConfig(cfg);
	if (!channel) return null;
	const accounts = isRecord(channel.accounts) ? channel.accounts : null;
	if (!accounts) return null;
	const entry = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
	return isRecord(entry) ? entry : null;
}
function resolveConfiguredMatrixAccountIds(cfg, env = process.env) {
	const channel = resolveMatrixChannelConfig(cfg);
	const configuredAccountIds = listConfiguredAccountIds({
		accounts: channel && isRecord(channel.accounts) ? channel.accounts : void 0,
		normalizeAccountId
	});
	if (hasConfiguredDefaultMatrixAccountSource({
		channel,
		env
	})) configuredAccountIds.push(DEFAULT_ACCOUNT_ID);
	return listCombinedAccountIds({
		configuredAccountIds,
		additionalAccountIds: listMatrixEnvAccountIds(env).filter((accountId) => normalizeAccountId(accountId) === "default" ? hasConfiguredDefaultMatrixAccountSource({
			channel,
			env
		}) : hasUsableEffectiveMatrixAccountSource({
			channel,
			accountId,
			env
		})),
		fallbackAccountIdWhenEmpty: channel ? DEFAULT_ACCOUNT_ID : void 0
	});
}
function resolveMatrixDefaultOrOnlyAccountId(cfg, env = process.env) {
	const channel = resolveMatrixChannelConfig(cfg);
	if (!channel) return DEFAULT_ACCOUNT_ID;
	const configuredDefault = normalizeOptionalAccountId(typeof channel.defaultAccount === "string" ? channel.defaultAccount : void 0);
	return resolveListedDefaultAccountId({
		accountIds: resolveConfiguredMatrixAccountIds(cfg, env),
		configuredDefaultAccountId: configuredDefault,
		ambiguousFallbackAccountId: DEFAULT_ACCOUNT_ID
	});
}
function requiresExplicitMatrixDefaultAccount(cfg, env = process.env) {
	const channel = resolveMatrixChannelConfig(cfg);
	if (!channel) return false;
	const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg, env);
	if (configuredAccountIds.length <= 1) return false;
	if (configuredAccountIds.includes("default")) return false;
	const configuredDefault = normalizeOptionalAccountId(typeof channel.defaultAccount === "string" ? channel.defaultAccount : void 0);
	return !(configuredDefault && configuredAccountIds.includes(configuredDefault));
}
//#endregion
export { resolveMatrixDefaultOrOnlyAccountId as a, resolveMatrixChannelConfig as i, requiresExplicitMatrixDefaultAccount as n, resolveMatrixAccountStringValues as o, resolveConfiguredMatrixAccountIds as r, findMatrixAccountEntry as t };
