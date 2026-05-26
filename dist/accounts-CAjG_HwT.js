import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-runtime-BxNajKSO.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, o as resolveMatrixAccountStringValues, r as resolveConfiguredMatrixAccountIds } from "./account-selection-CfoMW0gI.js";
import { a as resolveMatrixAccountConfig, o as resolveMatrixBaseConfig, t as findMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { i as resolveScopedMatrixEnvConfig, n as resolveGlobalMatrixEnvConfig } from "./env-auth-RoZX59IM.js";
import { n as credentialsMatchConfig, r as loadMatrixCredentials } from "./credentials-read-CCifjupZ.js";
//#region extensions/matrix/src/matrix/accounts.ts
function clean(value) {
	return normalizeOptionalString(value) ?? "";
}
function resolveMatrixAccountAuthView(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const matrix = resolveMatrixBaseConfig(params.cfg);
	const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
	const resolvedStrings = resolveMatrixAccountStringValues({
		accountId: normalizedAccountId,
		account: {
			homeserver: clean(account.homeserver),
			userId: clean(account.userId),
			accessToken: typeof account.accessToken === "string" ? clean(account.accessToken) : "",
			password: typeof account.password === "string" ? clean(account.password) : "",
			deviceId: clean(account.deviceId),
			deviceName: clean(account.deviceName)
		},
		scopedEnv: resolveScopedMatrixEnvConfig(normalizedAccountId, params.env),
		channel: {
			homeserver: clean(matrix.homeserver),
			userId: clean(matrix.userId),
			accessToken: typeof matrix.accessToken === "string" ? clean(matrix.accessToken) : "",
			password: typeof matrix.password === "string" ? clean(matrix.password) : "",
			deviceId: clean(matrix.deviceId),
			deviceName: clean(matrix.deviceName)
		},
		globalEnv: resolveGlobalMatrixEnvConfig(params.env)
	});
	return {
		homeserver: resolvedStrings.homeserver,
		userId: resolvedStrings.userId,
		accessToken: resolvedStrings.accessToken || void 0,
		password: resolvedStrings.password || void 0
	};
}
function resolveMatrixAccountUserId(params) {
	const env = params.env ?? process.env;
	const authView = resolveMatrixAccountAuthView({
		cfg: params.cfg,
		accountId: params.accountId,
		env
	});
	const configuredUserId = authView.userId.trim();
	if (configuredUserId) return configuredUserId;
	const stored = loadMatrixCredentials(env, params.accountId);
	if (!stored) return null;
	if (authView.homeserver && stored.homeserver !== authView.homeserver) return null;
	if (authView.accessToken && stored.accessToken !== authView.accessToken) return null;
	return stored.userId.trim() || null;
}
function listMatrixAccountIds(cfg) {
	const ids = resolveConfiguredMatrixAccountIds(cfg, process.env);
	return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}
function resolveDefaultMatrixAccountId(cfg) {
	return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
}
function resolveConfiguredMatrixBotUserIds(params) {
	const env = params.env ?? process.env;
	const currentAccountId = normalizeAccountId(params.accountId);
	const accountIds = new Set(resolveConfiguredMatrixAccountIds(params.cfg, env));
	if (resolveMatrixAccount({
		cfg: params.cfg,
		accountId: "default",
		env
	}).configured) accountIds.add(DEFAULT_ACCOUNT_ID);
	const ids = /* @__PURE__ */ new Set();
	for (const accountId of accountIds) {
		if (normalizeAccountId(accountId) === currentAccountId) continue;
		if (!resolveMatrixAccount({
			cfg: params.cfg,
			accountId,
			env
		}).configured) continue;
		const userId = resolveMatrixAccountUserId({
			cfg: params.cfg,
			accountId,
			env
		});
		if (userId) ids.add(userId);
	}
	return ids;
}
function resolveMatrixAccount(params) {
	const env = params.env ?? process.env;
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultMatrixAccountId(params.cfg));
	const matrixBase = resolveMatrixBaseConfig(params.cfg);
	const base = resolveMatrixAccountConfig({
		cfg: params.cfg,
		accountId,
		env
	});
	const explicitAuthConfig = accountId === "default" ? base : findMatrixAccountConfig(params.cfg, accountId) ?? {};
	const enabled = base.enabled !== false && matrixBase.enabled !== false;
	const authView = resolveMatrixAccountAuthView({
		cfg: params.cfg,
		accountId,
		env
	});
	const hasHomeserver = Boolean(authView.homeserver);
	const hasUserId = Boolean(authView.userId);
	const hasAccessToken = Boolean(authView.accessToken) || hasConfiguredSecretInput(explicitAuthConfig.accessToken);
	const hasPassword = Boolean(authView.password);
	const hasPasswordAuth = hasUserId && (hasPassword || hasConfiguredSecretInput(explicitAuthConfig.password));
	const stored = loadMatrixCredentials(env, accountId);
	const hasStored = stored && authView.homeserver ? credentialsMatchConfig(stored, {
		homeserver: authView.homeserver,
		userId: authView.userId || ""
	}) : false;
	const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || hasStored);
	return {
		accountId,
		enabled,
		name: normalizeOptionalString(base.name),
		configured,
		homeserver: authView.homeserver || void 0,
		userId: authView.userId || void 0,
		config: base
	};
}
//#endregion
export { resolveMatrixAccount as i, resolveConfiguredMatrixBotUserIds as n, resolveDefaultMatrixAccountId as r, listMatrixAccountIds as t };
