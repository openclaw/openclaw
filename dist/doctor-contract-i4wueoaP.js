import { t as asObjectRecord } from "./runtime-doctor-p5TvjiM-.js";
//#region extensions/googlechat/src/doctor-contract.ts
function hasLegacyGoogleChatStreamMode(value) {
	return asObjectRecord(value)?.streamMode !== void 0;
}
function hasLegacyGoogleChatGroupAllowAlias(value) {
	const groups = asObjectRecord(asObjectRecord(value)?.groups);
	if (!groups) return false;
	return Object.values(groups).some((group) => Object.prototype.hasOwnProperty.call(asObjectRecord(group) ?? {}, "allow"));
}
function hasLegacyAccountAliases(value, match) {
	const accounts = asObjectRecord(value);
	if (!accounts) return false;
	return Object.values(accounts).some((account) => match(account));
}
function normalizeGoogleChatGroups(params) {
	let changed = false;
	const nextGroups = { ...params.groups };
	for (const [groupId, groupValue] of Object.entries(params.groups)) {
		const group = asObjectRecord(groupValue);
		if (!group || !Object.prototype.hasOwnProperty.call(group, "allow")) continue;
		const nextGroup = { ...group };
		if (nextGroup.enabled === void 0) {
			nextGroup.enabled = group.allow;
			params.changes.push(`Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled.`);
		} else params.changes.push(`Removed ${params.pathPrefix}.${groupId}.allow (${params.pathPrefix}.${groupId}.enabled already set).`);
		delete nextGroup.allow;
		nextGroups[groupId] = nextGroup;
		changed = true;
	}
	return {
		groups: nextGroups,
		changed
	};
}
function normalizeGoogleChatEntry(params) {
	let updated = params.entry;
	let changed = false;
	if (updated.streamMode !== void 0) {
		updated = { ...updated };
		delete updated.streamMode;
		params.changes.push(`Removed ${params.pathPrefix}.streamMode (legacy key no longer used).`);
		changed = true;
	}
	const groups = asObjectRecord(updated.groups);
	if (groups) {
		const normalized = normalizeGoogleChatGroups({
			groups,
			pathPrefix: `${params.pathPrefix}.groups`,
			changes: params.changes
		});
		if (normalized.changed) {
			updated = {
				...updated,
				groups: normalized.groups
			};
			changed = true;
		}
	}
	return {
		entry: updated,
		changed
	};
}
const legacyConfigRules = [
	{
		path: ["channels", "googlechat"],
		message: "channels.googlechat.streamMode is legacy and no longer used; it is removed on load.",
		match: hasLegacyGoogleChatStreamMode
	},
	{
		path: [
			"channels",
			"googlechat",
			"accounts"
		],
		message: "channels.googlechat.accounts.<id>.streamMode is legacy and no longer used; it is removed on load.",
		match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatStreamMode)
	},
	{
		path: ["channels", "googlechat"],
		message: "channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead. Run \"openclaw doctor --fix\".",
		match: hasLegacyGoogleChatGroupAllowAlias
	},
	{
		path: [
			"channels",
			"googlechat",
			"accounts"
		],
		message: "channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run \"openclaw doctor --fix\".",
		match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatGroupAllowAlias)
	}
];
function normalizeCompatibilityConfig({ cfg }) {
	const rawEntry = asObjectRecord(cfg.channels?.googlechat);
	if (!rawEntry) return {
		config: cfg,
		changes: []
	};
	const changes = [];
	let updated = rawEntry;
	let changed = false;
	const root = normalizeGoogleChatEntry({
		entry: updated,
		pathPrefix: "channels.googlechat",
		changes
	});
	updated = root.entry;
	changed = root.changed;
	const accounts = asObjectRecord(updated.accounts);
	if (accounts) {
		let accountsChanged = false;
		const nextAccounts = { ...accounts };
		for (const [accountId, accountValue] of Object.entries(accounts)) {
			const account = asObjectRecord(accountValue);
			if (!account) continue;
			const normalized = normalizeGoogleChatEntry({
				entry: account,
				pathPrefix: `channels.googlechat.accounts.${accountId}`,
				changes
			});
			if (!normalized.changed) continue;
			nextAccounts[accountId] = normalized.entry;
			accountsChanged = true;
		}
		if (accountsChanged) {
			updated = {
				...updated,
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
				googlechat: updated
			}
		},
		changes
	};
}
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
