import { n as normalizeAccountId } from "./account-id-9_btbLFO.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-D_ZmBZUK.js";
import "./account-core-i5NR1Ikx.js";
import { i as createResolvedDirectoryEntriesLister } from "./directory-config-helpers-zR3EhzS0.js";
import { t as mergeTelegramAccountConfig } from "./account-config-By9B3u2Z.js";
import { r as resolveDefaultTelegramAccountSelection } from "./account-selection-BI7OmRZk.js";
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
