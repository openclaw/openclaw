import { n as normalizeAccountId, r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-Bj7l9NI7.js";
//#region extensions/telegram/src/account-selection.ts
const DEFAULT_AGENT_ID = "main";
function normalizeAgentId(value) {
	return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "") || DEFAULT_AGENT_ID;
}
function normalizeChannelId(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function resolveDefaultAgentId(cfg) {
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const chosen = (agents.find((agent) => agent?.default) ?? agents[0])?.id;
	return normalizeAgentId(chosen);
}
function listConfiguredAccountIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	for (const key of Object.keys(cfg.channels?.telegram?.accounts ?? {})) if (key) ids.add(normalizeAccountId(key));
	return [...ids];
}
function resolveBindingAccount(params) {
	if (!params.binding || typeof params.binding !== "object") return null;
	const binding = params.binding;
	if (normalizeChannelId(binding.match?.channel) !== params.channelId) return null;
	const accountId = typeof binding.match?.accountId === "string" ? binding.match.accountId : "";
	if (!accountId.trim() || accountId.trim() === "*") return null;
	return {
		agentId: normalizeAgentId(typeof binding.agentId === "string" ? binding.agentId : void 0),
		accountId: normalizeAccountId(accountId)
	};
}
function listBoundAccountIds(cfg, channelId) {
	const ids = /* @__PURE__ */ new Set();
	for (const binding of cfg.bindings ?? []) {
		const resolved = resolveBindingAccount({
			binding,
			channelId
		});
		if (resolved) ids.add(resolved.accountId);
	}
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function resolveDefaultAgentBoundAccountId(cfg, channelId) {
	const defaultAgentId = resolveDefaultAgentId(cfg);
	for (const binding of cfg.bindings ?? []) {
		const resolved = resolveBindingAccount({
			binding,
			channelId
		});
		if (resolved?.agentId === defaultAgentId) return resolved.accountId;
	}
	return null;
}
function combineAccountIds(params) {
	const ids = /* @__PURE__ */ new Set();
	for (const id of [...params.configuredAccountIds, ...params.additionalAccountIds]) ids.add(normalizeAccountId(id));
	if (ids.size === 0) return [DEFAULT_ACCOUNT_ID];
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function resolveListedDefaultAccountId(params) {
	const configured = normalizeOptionalAccountId(params.configuredDefaultAccountId);
	if (configured && params.accountIds.includes(configured)) return configured;
	if (params.accountIds.includes("default")) return DEFAULT_ACCOUNT_ID;
	return params.accountIds[0] ?? "default";
}
function listTelegramAccountIds(cfg) {
	return combineAccountIds({
		configuredAccountIds: listConfiguredAccountIds(cfg),
		additionalAccountIds: listBoundAccountIds(cfg, "telegram")
	});
}
function resolveDefaultTelegramAccountSelection(cfg) {
	const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
	if (boundDefault) return {
		accountId: boundDefault,
		accountIds: listTelegramAccountIds(cfg),
		shouldWarnMissingDefault: false
	};
	const accountIds = listTelegramAccountIds(cfg);
	const resolved = resolveListedDefaultAccountId({
		accountIds,
		configuredDefaultAccountId: cfg.channels?.telegram?.defaultAccount
	});
	return {
		accountId: resolved,
		accountIds,
		shouldWarnMissingDefault: resolved === accountIds[0] && !accountIds.includes("default") && accountIds.length > 1
	};
}
function resolveDefaultTelegramAccountId(cfg) {
	return resolveDefaultTelegramAccountSelection(cfg).accountId;
}
//#endregion
export { resolveDefaultTelegramAccountId as n, resolveDefaultTelegramAccountSelection as r, listTelegramAccountIds as t };
