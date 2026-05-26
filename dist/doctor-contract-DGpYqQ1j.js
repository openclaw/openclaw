import { c as isRecord } from "./utils-sBTEdeml.js";
import { i as hasLegacyFlatAllowPrivateNetworkAlias, s as migrateLegacyFlatAllowPrivateNetworkAlias } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./record-shared-DQ4sTnau.js";
//#region extensions/matrix/src/doctor-contract.ts
function hasLegacyMatrixRoomAllowAlias(value) {
	const room = isRecord(value) ? value : null;
	return Boolean(room && typeof room.allow === "boolean");
}
function hasLegacyMatrixRoomMapAllowAliases(value) {
	const rooms = isRecord(value) ? value : null;
	return Boolean(rooms && Object.values(rooms).some((room) => hasLegacyMatrixRoomAllowAlias(room)));
}
function hasLegacyMatrixAccountRoomAllowAliases(value) {
	const accounts = isRecord(value) ? value : null;
	if (!accounts) return false;
	return Object.values(accounts).some((account) => {
		if (!isRecord(account)) return false;
		return hasLegacyMatrixRoomMapAllowAliases(account.groups) || hasLegacyMatrixRoomMapAllowAliases(account.rooms);
	});
}
function hasLegacyMatrixAccountPrivateNetworkAliases(value) {
	const accounts = isRecord(value) ? value : null;
	if (!accounts) return false;
	return Object.values(accounts).some((account) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}));
}
function hasLegacyTrustedDmPolicy(value) {
	const root = isRecord(value) ? value : null;
	if (!root) return false;
	return (isRecord(root.dm) ? root.dm : null)?.policy === "trusted";
}
function hasLegacyMatrixAccountTrustedDmPolicies(value) {
	const accounts = isRecord(value) ? value : null;
	if (!accounts) return false;
	return Object.values(accounts).some((account) => hasLegacyTrustedDmPolicy(account));
}
function migrateLegacyTrustedDmPolicy(params) {
	const dm = isRecord(params.entry.dm) ? params.entry.dm : null;
	if (!dm || dm.policy !== "trusted") return {
		entry: params.entry,
		changed: false
	};
	const allowFromRaw = dm.allowFrom;
	const allowFromEntries = Array.isArray(allowFromRaw) ? allowFromRaw.filter((entry) => typeof entry === "string" && entry.trim().length > 0).length : 0;
	const nextPolicy = allowFromEntries > 0 ? "allowlist" : "pairing";
	const nextDm = {
		...dm,
		policy: nextPolicy
	};
	params.changes.push(`Migrated ${params.pathPrefix}.dm.policy "trusted" → "${nextPolicy}" (legacy alias removed; ${allowFromEntries > 0 ? `preserved ${allowFromEntries} ${params.pathPrefix}.dm.allowFrom ${allowFromEntries === 1 ? "entry" : "entries"}` : "no allowFrom entries present, defaulting to pairing for safety"}).`);
	return {
		entry: {
			...params.entry,
			dm: nextDm
		},
		changed: true
	};
}
function normalizeMatrixRoomAllowAliases(params) {
	let changed = false;
	const nextRooms = { ...params.rooms };
	for (const [roomId, roomValue] of Object.entries(params.rooms)) {
		const room = isRecord(roomValue) ? roomValue : null;
		if (!room || typeof room.allow !== "boolean") continue;
		const nextRoom = { ...room };
		if (typeof nextRoom.enabled !== "boolean") nextRoom.enabled = room.allow;
		delete nextRoom.allow;
		nextRooms[roomId] = nextRoom;
		changed = true;
		params.changes.push(`Moved ${params.pathPrefix}.${roomId}.allow → ${params.pathPrefix}.${roomId}.enabled (${String(nextRoom.enabled)}).`);
	}
	return {
		rooms: nextRooms,
		changed
	};
}
const legacyConfigRules = [
	{
		path: ["channels", "matrix"],
		message: "channels.matrix.allowPrivateNetwork is legacy; use channels.matrix.network.dangerouslyAllowPrivateNetwork instead. Run \"openclaw doctor --fix\".",
		match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {})
	},
	{
		path: [
			"channels",
			"matrix",
			"accounts"
		],
		message: "channels.matrix.accounts.<id>.allowPrivateNetwork is legacy; use channels.matrix.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyMatrixAccountPrivateNetworkAliases
	},
	{
		path: [
			"channels",
			"matrix",
			"groups"
		],
		message: "channels.matrix.groups.<room>.allow is legacy; use channels.matrix.groups.<room>.enabled instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyMatrixRoomMapAllowAliases
	},
	{
		path: [
			"channels",
			"matrix",
			"rooms"
		],
		message: "channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyMatrixRoomMapAllowAliases
	},
	{
		path: [
			"channels",
			"matrix",
			"accounts"
		],
		message: "channels.matrix.accounts.<id>.{groups,rooms}.<room>.allow is legacy; use channels.matrix.accounts.<id>.{groups,rooms}.<room>.enabled instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyMatrixAccountRoomAllowAliases
	},
	{
		path: ["channels", "matrix"],
		message: "channels.matrix.dm.policy \"trusted\" is legacy; use \"allowlist\" (with allowFrom entries) or \"pairing\" instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyTrustedDmPolicy
	},
	{
		path: [
			"channels",
			"matrix",
			"accounts"
		],
		message: "channels.matrix.accounts.<id>.dm.policy \"trusted\" is legacy; use \"allowlist\" (with allowFrom entries) or \"pairing\" instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyMatrixAccountTrustedDmPolicies
	}
];
function normalizeCompatibilityConfig({ cfg }) {
	const channels = isRecord(cfg.channels) ? cfg.channels : null;
	const matrix = isRecord(channels?.matrix) ? channels.matrix : null;
	if (!matrix) return {
		config: cfg,
		changes: []
	};
	const changes = [];
	let updatedMatrix = matrix;
	let changed = false;
	const topLevelPrivateNetwork = migrateLegacyFlatAllowPrivateNetworkAlias({
		entry: updatedMatrix,
		pathPrefix: "channels.matrix",
		changes
	});
	updatedMatrix = topLevelPrivateNetwork.entry;
	changed = changed || topLevelPrivateNetwork.changed;
	const topLevelTrustedDmPolicy = migrateLegacyTrustedDmPolicy({
		entry: updatedMatrix,
		pathPrefix: "channels.matrix",
		changes
	});
	updatedMatrix = topLevelTrustedDmPolicy.entry;
	changed = changed || topLevelTrustedDmPolicy.changed;
	const normalizeTopLevelRoomScope = (key) => {
		const rooms = isRecord(updatedMatrix[key]) ? updatedMatrix[key] : null;
		if (!rooms) return;
		const normalized = normalizeMatrixRoomAllowAliases({
			rooms,
			pathPrefix: `channels.matrix.${key}`,
			changes
		});
		if (normalized.changed) {
			updatedMatrix = {
				...updatedMatrix,
				[key]: normalized.rooms
			};
			changed = true;
		}
	};
	normalizeTopLevelRoomScope("groups");
	normalizeTopLevelRoomScope("rooms");
	const accounts = isRecord(updatedMatrix.accounts) ? updatedMatrix.accounts : null;
	if (accounts) {
		let accountsChanged = false;
		const nextAccounts = { ...accounts };
		for (const [accountId, accountValue] of Object.entries(accounts)) {
			const account = isRecord(accountValue) ? accountValue : null;
			if (!account) continue;
			let nextAccount = account;
			let accountChanged = false;
			const privateNetworkMigration = migrateLegacyFlatAllowPrivateNetworkAlias({
				entry: nextAccount,
				pathPrefix: `channels.matrix.accounts.${accountId}`,
				changes
			});
			if (privateNetworkMigration.changed) {
				nextAccount = privateNetworkMigration.entry;
				accountChanged = true;
			}
			const accountTrustedDmPolicy = migrateLegacyTrustedDmPolicy({
				entry: nextAccount,
				pathPrefix: `channels.matrix.accounts.${accountId}`,
				changes
			});
			if (accountTrustedDmPolicy.changed) {
				nextAccount = accountTrustedDmPolicy.entry;
				accountChanged = true;
			}
			for (const key of ["groups", "rooms"]) {
				const rooms = isRecord(nextAccount[key]) ? nextAccount[key] : null;
				if (!rooms) continue;
				const normalized = normalizeMatrixRoomAllowAliases({
					rooms,
					pathPrefix: `channels.matrix.accounts.${accountId}.${key}`,
					changes
				});
				if (normalized.changed) {
					nextAccount = {
						...nextAccount,
						[key]: normalized.rooms
					};
					accountChanged = true;
				}
			}
			if (accountChanged) {
				nextAccounts[accountId] = nextAccount;
				accountsChanged = true;
			}
		}
		if (accountsChanged) {
			updatedMatrix = {
				...updatedMatrix,
				accounts: nextAccounts
			};
			changed = true;
		}
	}
	if (!changed) return {
		config: cfg,
		changes: []
	};
	return {
		config: {
			...cfg,
			channels: {
				...cfg.channels,
				matrix: updatedMatrix
			}
		},
		changes
	};
}
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
