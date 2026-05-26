import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { i as createResolvedDirectoryEntriesLister } from "./directory-config-helpers-DE5wfd2q.js";
import "./account-resolution-CpfIEmNk.js";
import { i as resolveDefaultSlackAccountId, o as resolveSlackAccountAllowFrom, r as mergeSlackAccountConfig } from "./accounts-Ba1LnRZV.js";
import { r as parseSlackTarget } from "./target-parsing-V_XPO9_R.js";
//#region extensions/slack/src/directory-config.ts
function resolveSlackDirectoryConfigAccount(cfg, accountId) {
	const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultSlackAccountId(cfg));
	const config = mergeSlackAccountConfig(cfg, resolvedAccountId);
	return {
		accountId: resolvedAccountId,
		config,
		dm: config.dm,
		allowFrom: resolveSlackAccountAllowFrom({
			cfg,
			accountId: resolvedAccountId
		}) ?? []
	};
}
const listSlackDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister({
	kind: "user",
	resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
	resolveSources: (account) => {
		const channelUsers = Object.values(account.config.channels ?? {}).flatMap((channel) => channel.users ?? []);
		return [
			account.allowFrom,
			Object.keys(account.config.dms ?? {}),
			channelUsers
		];
	},
	normalizeId: (raw) => {
		const normalizedUserId = (raw.match(/^<@([A-Z0-9]+)>$/i)?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
		if (!normalizedUserId) return null;
		const normalized = parseSlackTarget(`user:${normalizedUserId}`, { defaultKind: "user" });
		return normalized?.kind === "user" ? `user:${normalizeLowercaseStringOrEmpty(normalized.id)}` : null;
	}
});
const listSlackDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister({
	kind: "group",
	resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
	resolveSources: (account) => [Object.keys(account.config.channels ?? {})],
	normalizeId: (raw) => {
		const normalized = parseSlackTarget(raw, { defaultKind: "channel" });
		return normalized?.kind === "channel" ? `channel:${normalizeLowercaseStringOrEmpty(normalized.id)}` : null;
	}
});
//#endregion
export { listSlackDirectoryPeersFromConfig as n, listSlackDirectoryGroupsFromConfig as t };
