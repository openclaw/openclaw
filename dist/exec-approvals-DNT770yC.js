import { d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-CU1TPzr2.js";
import { r as isChannelExecApprovalTargetRecipient, t as createChannelExecApprovalProfile } from "./approval-client-helpers-pa7NGsBg.js";
import "./approval-client-runtime-Ci76AieJ.js";
import { a as doesApprovalRequestMatchChannelAccount } from "./exec-approval-session-target-BSr7uNdj.js";
import "./approval-native-runtime-Bm65xYGS.js";
import { a as resolveSlackAccount } from "./accounts-Ba1LnRZV.js";
//#region extensions/slack/src/exec-approvals.ts
function normalizeSlackApproverId(value) {
	const trimmed = normalizeStringifiedOptionalString(value);
	if (!trimmed) return;
	const prefixed = trimmed.match(/^(?:slack|user):([A-Z0-9]+)$/i);
	if (prefixed?.[1]) return prefixed[1];
	const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
	if (mention?.[1]) return mention[1];
	return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed : void 0;
}
function resolveSlackOwnerApprovers(cfg) {
	const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
	if (!Array.isArray(ownerAllowFrom) || ownerAllowFrom.length === 0) return [];
	return resolveApprovalApprovers({
		explicit: ownerAllowFrom,
		normalizeApprover: normalizeSlackApproverId
	});
}
function getSlackExecApprovalApprovers(params) {
	const account = resolveSlackAccount(params).config;
	return resolveApprovalApprovers({
		explicit: account.execApprovals?.approvers ?? resolveSlackOwnerApprovers(params.cfg),
		normalizeApprover: normalizeSlackApproverId
	});
}
function isSlackExecApprovalTargetRecipient(params) {
	return isChannelExecApprovalTargetRecipient({
		...params,
		channel: "slack",
		normalizeSenderId: normalizeSlackApproverId,
		matchTarget: ({ target, normalizedSenderId }) => normalizeSlackApproverId(target.to) === normalizedSenderId
	});
}
const slackExecApprovalProfile = createChannelExecApprovalProfile({
	resolveConfig: (params) => resolveSlackAccount(params).config.execApprovals,
	resolveApprovers: getSlackExecApprovalApprovers,
	normalizeSenderId: normalizeSlackApproverId,
	isTargetRecipient: isSlackExecApprovalTargetRecipient,
	matchesRequestAccount: (params) => doesApprovalRequestMatchChannelAccount({
		cfg: params.cfg,
		request: params.request,
		channel: "slack",
		accountId: params.accountId
	})
});
const isSlackExecApprovalClientEnabled = slackExecApprovalProfile.isClientEnabled;
const isSlackExecApprovalApprover = slackExecApprovalProfile.isApprover;
const isSlackExecApprovalAuthorizedSender = slackExecApprovalProfile.isAuthorizedSender;
const resolveSlackExecApprovalTarget = slackExecApprovalProfile.resolveTarget;
const shouldHandleSlackExecApprovalRequest = slackExecApprovalProfile.shouldHandleRequest;
const shouldSuppressLocalSlackExecApprovalPrompt = slackExecApprovalProfile.shouldSuppressLocalPrompt;
//#endregion
export { normalizeSlackApproverId as a, shouldSuppressLocalSlackExecApprovalPrompt as c, isSlackExecApprovalClientEnabled as i, isSlackExecApprovalApprover as n, resolveSlackExecApprovalTarget as o, isSlackExecApprovalAuthorizedSender as r, shouldHandleSlackExecApprovalRequest as s, getSlackExecApprovalApprovers as t };
