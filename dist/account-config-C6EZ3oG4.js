import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { c as resolveMergedAccountConfig } from "./account-helpers-BEXOONiv.js";
import { t as listConfiguredAccountIds } from "./account-configured-ids-C2qgDow6.js";
import "./secret-input-runtime-BxNajKSO.js";
//#region extensions/matrix/src/matrix/account-config.ts
function resolveMatrixBaseConfig(cfg) {
	return cfg.channels?.matrix ?? {};
}
function resolveMatrixAccountsMap(cfg) {
	const accounts = resolveMatrixBaseConfig(cfg).accounts;
	if (!accounts || typeof accounts !== "object") return {};
	return accounts;
}
function selectInheritedMatrixRoomEntries(params) {
	const entries = params.entries;
	if (!entries) return;
	const selected = Object.fromEntries(Object.entries(entries).filter(([, value]) => {
		const scopedAccount = typeof value?.account === "string" ? normalizeAccountId(value.account) : void 0;
		return scopedAccount === void 0 || scopedAccount === params.accountId;
	}));
	return Object.keys(selected).length > 0 ? selected : void 0;
}
function mergeMatrixRoomEntries(inherited, accountEntries, hasAccountOverride) {
	if (!inherited && !accountEntries) return;
	if (hasAccountOverride && Object.keys(accountEntries ?? {}).length === 0) return;
	const merged = { ...inherited };
	for (const [key, value] of Object.entries(accountEntries ?? {})) {
		const inheritedValue = merged[key];
		merged[key] = inheritedValue && value ? {
			...inheritedValue,
			...value
		} : value ?? inheritedValue;
	}
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function listNormalizedMatrixAccountIds(cfg) {
	return listConfiguredAccountIds({
		accounts: resolveMatrixAccountsMap(cfg),
		normalizeAccountId
	});
}
function findMatrixAccountConfig(cfg, accountId) {
	return resolveNormalizedAccountEntry(resolveMatrixAccountsMap(cfg), accountId, normalizeAccountId);
}
function hasExplicitMatrixAccountConfig(cfg, accountId) {
	const normalized = normalizeAccountId(accountId);
	if (findMatrixAccountConfig(cfg, normalized)) return true;
	if (normalized !== "default") return false;
	const matrix = resolveMatrixBaseConfig(cfg);
	return typeof matrix.enabled === "boolean" || typeof matrix.name === "string" || typeof matrix.homeserver === "string" || typeof matrix.userId === "string" || hasConfiguredSecretInput(matrix.accessToken) || hasConfiguredSecretInput(matrix.password) || typeof matrix.deviceId === "string" || typeof matrix.deviceName === "string" || typeof matrix.avatarUrl === "string";
}
function resolveMatrixAccountConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const base = resolveMatrixBaseConfig(params.cfg);
	const merged = resolveMergedAccountConfig({
		channelConfig: base,
		accounts: params.cfg.channels?.matrix?.accounts,
		accountId,
		normalizeAccountId,
		nestedObjectKeys: [
			"dm",
			"actions",
			"execApprovals",
			"botLoopProtection"
		]
	});
	const accountConfig = findMatrixAccountConfig(params.cfg, accountId);
	const groups = mergeMatrixRoomEntries(selectInheritedMatrixRoomEntries({
		entries: base.groups,
		accountId
	}), accountConfig?.groups, Boolean(accountConfig && Object.hasOwn(accountConfig, "groups")));
	const rooms = mergeMatrixRoomEntries(selectInheritedMatrixRoomEntries({
		entries: base.rooms,
		accountId
	}), accountConfig?.rooms, Boolean(accountConfig && Object.hasOwn(accountConfig, "rooms")));
	const { groups: _ignoredGroups, rooms: _ignoredRooms, ...rest } = merged;
	return {
		...rest,
		...groups ? { groups } : {},
		...rooms ? { rooms } : {}
	};
}
function resolveMatrixAccountAllowlistConfig(params) {
	const accountId = normalizeAccountId(params.accountId);
	const base = resolveMatrixBaseConfig(params.cfg);
	const accountConfig = findMatrixAccountConfig(params.cfg, accountId);
	const accountDm = accountConfig?.dm;
	let dmAllowFrom = base.dm?.allowFrom;
	if (accountDm && Object.hasOwn(accountDm, "allowFrom")) dmAllowFrom = accountDm.allowFrom;
	let groupAllowFrom = base.groupAllowFrom;
	if (accountConfig && Object.hasOwn(accountConfig, "groupAllowFrom")) groupAllowFrom = accountConfig.groupAllowFrom;
	return {
		dmAllowFrom,
		groupAllowFrom
	};
}
//#endregion
export { resolveMatrixAccountConfig as a, resolveMatrixAccountAllowlistConfig as i, hasExplicitMatrixAccountConfig as n, resolveMatrixBaseConfig as o, listNormalizedMatrixAccountIds as r, findMatrixAccountConfig as t };
