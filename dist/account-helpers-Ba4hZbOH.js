import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-CwBWagLE.js";
import { n as resolveNormalizedAccountEntry, t as resolveAccountEntry } from "./account-lookup-DAEppsQ5.js";
//#region src/channels/plugins/account-helpers.ts
function createAccountListHelpers(channelKey, options) {
	function resolveConfiguredDefaultAccountId(cfg) {
		const channel = cfg.channels?.[channelKey];
		const preferred = normalizeOptionalAccountId(typeof channel?.defaultAccount === "string" ? channel.defaultAccount : void 0);
		if (!preferred) return;
		const ids = listAccountIds(cfg);
		if (options?.allowUnlistedDefaultAccount) return preferred;
		if (ids.some((id) => normalizeAccountId(id) === preferred)) return preferred;
	}
	function listConfiguredAccountIds(cfg) {
		const accounts = (cfg.channels?.[channelKey])?.accounts;
		if (!accounts || typeof accounts !== "object") return [];
		const ids = Object.keys(accounts).filter(Boolean);
		const normalizeConfiguredAccountId = options?.normalizeAccountId;
		if (!normalizeConfiguredAccountId) return ids;
		return [...new Set(ids.map((id) => normalizeConfiguredAccountId(id)).filter(Boolean))];
	}
	function listAccountIds(cfg) {
		return listCombinedAccountIds({
			configuredAccountIds: listConfiguredAccountIds(cfg),
			fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID
		});
	}
	function resolveDefaultAccountId(cfg) {
		return resolveListedDefaultAccountId({
			accountIds: listAccountIds(cfg),
			configuredDefaultAccountId: resolveConfiguredDefaultAccountId(cfg),
			allowUnlistedDefaultAccount: options?.allowUnlistedDefaultAccount
		});
	}
	return {
		listConfiguredAccountIds,
		listAccountIds,
		resolveDefaultAccountId
	};
}
function listCombinedAccountIds(params) {
	const ids = /* @__PURE__ */ new Set();
	for (const id of params.configuredAccountIds) if (id) ids.add(id);
	for (const id of params.additionalAccountIds ?? []) if (id) ids.add(id);
	if (params.implicitAccountId) ids.add(params.implicitAccountId);
	if (ids.size === 0 && params.fallbackAccountIdWhenEmpty) return [params.fallbackAccountIdWhenEmpty];
	return [...ids].toSorted((a, b) => a.localeCompare(b));
}
function resolveListedDefaultAccountId(params) {
	const preferred = params.configuredDefaultAccountId;
	const normalizeListedAccountId = params.normalizeListedAccountId ?? normalizeAccountId;
	if (preferred && (params.allowUnlistedDefaultAccount || params.accountIds.some((accountId) => normalizeListedAccountId(accountId) === preferred))) return preferred;
	if (params.accountIds.includes("default")) return DEFAULT_ACCOUNT_ID;
	if (params.ambiguousFallbackAccountId && params.accountIds.length > 1) return params.ambiguousFallbackAccountId;
	return params.accountIds[0] ?? "default";
}
function mergeAccountConfig(params) {
	const omitKeys = new Set(["accounts", ...params.omitKeys ?? []]);
	const base = Object.fromEntries(Object.entries(params.channelConfig ?? {}).filter(([key]) => !omitKeys.has(key)));
	const merged = {
		...base,
		...params.accountConfig
	};
	for (const key of params.nestedObjectKeys ?? []) {
		const baseValue = base[key];
		const accountValue = params.accountConfig?.[key];
		if (typeof baseValue === "object" && baseValue != null && !Array.isArray(baseValue) && typeof accountValue === "object" && accountValue != null && !Array.isArray(accountValue)) merged[key] = {
			...baseValue,
			...accountValue
		};
	}
	return merged;
}
function resolveMergedAccountConfig(params) {
	const accountConfig = params.normalizeAccountId ? resolveNormalizedAccountEntry(params.accounts, params.accountId, params.normalizeAccountId) : resolveAccountEntry(params.accounts, params.accountId);
	return mergeAccountConfig({
		channelConfig: params.channelConfig,
		accountConfig,
		omitKeys: params.omitKeys,
		nestedObjectKeys: params.nestedObjectKeys
	});
}
function describeAccountSnapshot(params) {
	return {
		accountId: params.account.accountId ?? "default",
		name: normalizeOptionalString(params.account.name),
		enabled: params.account.enabled !== false,
		configured: params.configured,
		...params.extra
	};
}
function describeWebhookAccountSnapshot(params) {
	return describeAccountSnapshot({
		account: params.account,
		configured: params.configured,
		extra: {
			mode: params.mode ?? "webhook",
			...params.extra
		}
	});
}
//#endregion
export { mergeAccountConfig as a, listCombinedAccountIds as i, describeAccountSnapshot as n, resolveListedDefaultAccountId as o, describeWebhookAccountSnapshot as r, resolveMergedAccountConfig as s, createAccountListHelpers as t };
