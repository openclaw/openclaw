import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { t as getMatrixScopedEnvVarNames } from "./env-vars-J2eHsfqp.js";
//#region extensions/matrix/src/matrix/client/env-auth.ts
function cleanEnv(value) {
	return typeof value === "string" ? value.trim() : "";
}
function resolveGlobalMatrixEnvConfig(env) {
	return {
		homeserver: cleanEnv(env.MATRIX_HOMESERVER),
		userId: cleanEnv(env.MATRIX_USER_ID),
		accessToken: cleanEnv(env.MATRIX_ACCESS_TOKEN) || void 0,
		password: cleanEnv(env.MATRIX_PASSWORD) || void 0,
		deviceId: cleanEnv(env.MATRIX_DEVICE_ID) || void 0,
		deviceName: cleanEnv(env.MATRIX_DEVICE_NAME) || void 0
	};
}
function hasReadyMatrixEnvAuth(config) {
	const homeserver = cleanEnv(config.homeserver);
	const userId = cleanEnv(config.userId);
	const accessToken = cleanEnv(config.accessToken);
	const password = cleanEnv(config.password);
	return Boolean(homeserver && (accessToken || userId && password));
}
function resolveScopedMatrixEnvConfig(accountId, env = process.env) {
	const keys = getMatrixScopedEnvVarNames(accountId);
	return {
		homeserver: cleanEnv(env[keys.homeserver]),
		userId: cleanEnv(env[keys.userId]),
		accessToken: cleanEnv(env[keys.accessToken]) || void 0,
		password: cleanEnv(env[keys.password]) || void 0,
		deviceId: cleanEnv(env[keys.deviceId]) || void 0,
		deviceName: cleanEnv(env[keys.deviceName]) || void 0
	};
}
function resolveMatrixEnvAuthReadiness(accountId, env = process.env) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const scoped = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
	const scopedReady = hasReadyMatrixEnvAuth(scoped);
	if (normalizedAccountId !== "default") {
		const keys = getMatrixScopedEnvVarNames(normalizedAccountId);
		return {
			ready: scopedReady,
			homeserver: scoped.homeserver || void 0,
			userId: scoped.userId || void 0,
			sourceHint: `${keys.homeserver} (+ auth vars)`,
			missingMessage: `Set per-account env vars for "${normalizedAccountId}" (for example ${keys.homeserver} + ${keys.accessToken} or ${keys.userId} + ${keys.password}).`
		};
	}
	const defaultScoped = resolveScopedMatrixEnvConfig(DEFAULT_ACCOUNT_ID, env);
	const global = resolveGlobalMatrixEnvConfig(env);
	const defaultScopedReady = hasReadyMatrixEnvAuth(defaultScoped);
	const globalReady = hasReadyMatrixEnvAuth(global);
	const defaultKeys = getMatrixScopedEnvVarNames(DEFAULT_ACCOUNT_ID);
	return {
		ready: defaultScopedReady || globalReady,
		homeserver: defaultScoped.homeserver || global.homeserver || void 0,
		userId: defaultScoped.userId || global.userId || void 0,
		sourceHint: "MATRIX_* or MATRIX_DEFAULT_*",
		missingMessage: `Set Matrix env vars for the default account (for example MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN, MATRIX_USER_ID + MATRIX_PASSWORD, or ${defaultKeys.homeserver} + ${defaultKeys.accessToken}).`
	};
}
//#endregion
export { resolveScopedMatrixEnvConfig as i, resolveGlobalMatrixEnvConfig as n, resolveMatrixEnvAuthReadiness as r, hasReadyMatrixEnvAuth as t };
