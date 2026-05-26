import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/imessage/src/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("imessage", { implicitDefaultAccount: { channelKeys: ["cliPath", "dbPath"] } });
const listIMessageAccountIds = listAccountIds;
const resolveDefaultIMessageAccountId = resolveDefaultAccountId;
function mergeIMessageAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.imessage,
		accounts: cfg.channels?.imessage?.accounts,
		accountId
	});
}
function resolveIMessageAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultIMessageAccountId(params.cfg));
	const baseEnabled = params.cfg.channels?.imessage?.enabled !== false;
	const merged = mergeIMessageAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const configured = Boolean(merged.cliPath?.trim() || merged.dbPath?.trim() || merged.service || merged.region?.trim() || merged.allowFrom && merged.allowFrom.length > 0 || merged.groupAllowFrom && merged.groupAllowFrom.length > 0 || merged.dmPolicy || merged.groupPolicy || typeof merged.includeAttachments === "boolean" || merged.attachmentRoots && merged.attachmentRoots.length > 0 || merged.remoteAttachmentRoots && merged.remoteAttachmentRoots.length > 0 || typeof merged.mediaMaxMb === "number" || typeof merged.textChunkLimit === "number" || merged.groups && Object.keys(merged.groups).length > 0);
	return {
		accountId,
		enabled: baseEnabled && accountEnabled,
		name: normalizeOptionalString(merged.name),
		config: merged,
		configured
	};
}
function listEnabledIMessageAccounts(cfg) {
	return listIMessageAccountIds(cfg).map((accountId) => resolveIMessageAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
export { resolveIMessageAccount as i, listIMessageAccountIds as n, resolveDefaultIMessageAccountId as r, listEnabledIMessageAccounts as t };
