import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import "./account-core-DdyIQODw.js";
//#region extensions/telegram/src/account-config.ts
function normalizeAllowFromEntry(value) {
	return String(value).trim();
}
function hasWildcardAllowFrom(value) {
	return Array.isArray(value) && value.some((entry) => normalizeAllowFromEntry(entry) === "*");
}
function hasRestrictiveAllowFrom(value) {
	return Array.isArray(value) && value.some((entry) => {
		const normalized = normalizeAllowFromEntry(entry);
		return normalized.length > 0 && normalized !== "*";
	});
}
function dropWildcardAllowFrom(value) {
	return value.filter((entry) => normalizeAllowFromEntry(entry) !== "*");
}
function resolveMergedAllowFrom(params) {
	const { baseAllowFrom, accountAllowFrom } = params;
	if (hasRestrictiveAllowFrom(baseAllowFrom) && hasWildcardAllowFrom(accountAllowFrom)) {
		const accountRestrictiveEntries = Array.isArray(accountAllowFrom) ? dropWildcardAllowFrom(accountAllowFrom) : [];
		return accountRestrictiveEntries.length > 0 ? accountRestrictiveEntries : baseAllowFrom;
	}
	return accountAllowFrom ?? baseAllowFrom;
}
function resolveTelegramAccountConfig(cfg, accountId) {
	const normalized = normalizeAccountId(accountId);
	return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}
function mergeTelegramAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, groups: channelGroups, ...base } = cfg.channels?.telegram ?? {};
	const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};
	const isMultiAccount = Object.keys(cfg.channels?.telegram?.accounts ?? {}).length > 1;
	const hasAccountGroups = account.groups && Object.keys(account.groups).length > 0;
	const groups = isMultiAccount ? account.groups : hasAccountGroups ? account.groups : channelGroups;
	const allowFrom = resolveMergedAllowFrom({
		baseAllowFrom: base.allowFrom,
		accountAllowFrom: account.allowFrom
	});
	return {
		...base,
		...account,
		allowFrom,
		groups
	};
}
//#endregion
export { resolveTelegramAccountConfig as n, mergeTelegramAccountConfig as t };
