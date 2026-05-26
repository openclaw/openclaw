import { r as mergeInboundPathRoots } from "./inbound-path-policy-CMFnHCFD.js";
import { i as resolveIMessageAccount } from "./accounts-DwISomWw.js";
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
export { resolveIMessageAttachmentRoots as n, resolveIMessageRemoteAttachmentRoots as r, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS as t };
