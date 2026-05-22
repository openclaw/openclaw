import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as normalizeAccountId } from "./account-id-fkYplFFW.js";
import { r as mergeInboundPathRoots } from "./inbound-path-policy-BUj4xgiy.js";
import "./text-runtime-CFBwIeh_.js";
import { s as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-CZufvFy_.js";
import "./account-resolution-B_o8ev4g.js";
//#region extensions/imessage/src/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("imessage");
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
//#region extensions/imessage/src/media-contract.ts
const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS = ["/Users/*/Library/Messages/Attachments"];
function resolveIMessageAttachmentRoots(params) {
	return mergeInboundPathRoots(resolveIMessageAccount(params).config.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}
function resolveIMessageRemoteAttachmentRoots(params) {
	const account = resolveIMessageAccount(params);
	return mergeInboundPathRoots(account.config.remoteAttachmentRoots, params.cfg.channels?.imessage?.remoteAttachmentRoots, account.config.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}
//#endregion
export { listIMessageAccountIds as a, listEnabledIMessageAccounts as i, resolveIMessageAttachmentRoots as n, resolveDefaultIMessageAccountId as o, resolveIMessageRemoteAttachmentRoots as r, resolveIMessageAccount as s, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS as t };
