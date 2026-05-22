import { n as normalizeAccountId } from "./account-id-Bj7l9NI7.js";
//#region extensions/matrix/src/matrix/config-paths.ts
function shouldStoreMatrixAccountAtTopLevel(cfg, accountId) {
	if (normalizeAccountId(accountId) !== "default") return false;
	const accounts = cfg.channels?.matrix?.accounts;
	return !accounts || Object.keys(accounts).length === 0;
}
function resolveMatrixConfigPath(cfg, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	if (shouldStoreMatrixAccountAtTopLevel(cfg, normalizedAccountId)) return "channels.matrix";
	return `channels.matrix.accounts.${normalizedAccountId}`;
}
function resolveMatrixConfigFieldPath(cfg, accountId, fieldPath) {
	const suffix = fieldPath.trim().replace(/^\.+/, "");
	if (!suffix) return resolveMatrixConfigPath(cfg, accountId);
	return `${resolveMatrixConfigPath(cfg, accountId)}.${suffix}`;
}
//#endregion
export { resolveMatrixConfigPath as n, shouldStoreMatrixAccountAtTopLevel as r, resolveMatrixConfigFieldPath as t };
