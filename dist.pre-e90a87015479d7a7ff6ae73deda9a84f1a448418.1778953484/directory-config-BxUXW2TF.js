import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-DEa-Ib2y.js";
import "./account-core-u0aTtGDf.js";
import { i as createResolvedDirectoryEntriesLister } from "./directory-config-helpers-B9udMbmt.js";
import { t as mergeTelegramAccountConfig } from "./account-config-vFr2EU1d.js";
import { r as resolveDefaultTelegramAccountSelection } from "./account-selection-DAxPwaLA.js";
//#region extensions/telegram/src/directory-config.ts
function resolveTelegramDirectoryAccount(cfg, accountId) {
	return { config: mergeTelegramAccountConfig(cfg, accountId?.trim() ? normalizeAccountId(accountId) : resolveDefaultTelegramAccountSelection(cfg).accountId) };
}
const listTelegramDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister({
	kind: "user",
	resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
	resolveSources: (account) => [mapAllowFromEntries(account.config.allowFrom), Object.keys(account.config.dms ?? {})],
	normalizeId: (entry) => {
		const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
		if (!trimmed) return null;
		if (/^-?\d+$/.test(trimmed)) return trimmed;
		return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
	}
});
const listTelegramDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister({
	kind: "group",
	resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
	resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
	normalizeId: (entry) => entry.trim() || null
});
//#endregion
export { listTelegramDirectoryPeersFromConfig as n, listTelegramDirectoryGroupsFromConfig as t };
