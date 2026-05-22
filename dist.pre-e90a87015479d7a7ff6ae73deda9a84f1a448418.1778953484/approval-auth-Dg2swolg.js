import { t as resolveApprovalApprovers } from "./approval-approvers-BbnOU4Fu.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-BG6XGv7y.js";
import { a as resolveSlackAccount, o as resolveSlackAccountAllowFrom } from "./accounts-Cko9Q_Ps.js";
import { i as normalizeSlackApproverId } from "./exec-approvals-CukamCF5.js";
//#region extensions/slack/src/approval-auth.ts
function getSlackApprovalApprovers(params) {
	const account = resolveSlackAccount(params).config;
	return resolveApprovalApprovers({
		allowFrom: resolveSlackAccountAllowFrom(params),
		defaultTo: account.defaultTo,
		normalizeApprover: normalizeSlackApproverId,
		normalizeDefaultTo: normalizeSlackApproverId
	});
}
function isSlackApprovalAuthorizedSender(params) {
	const senderId = params.senderId ? normalizeSlackApproverId(params.senderId) : void 0;
	if (!senderId) return false;
	return getSlackApprovalApprovers(params).includes(senderId);
}
createResolvedApproverActionAuthAdapter({
	channelLabel: "Slack",
	resolveApprovers: ({ cfg, accountId }) => getSlackApprovalApprovers({
		cfg,
		accountId
	}),
	normalizeSenderId: (value) => normalizeSlackApproverId(value)
});
//#endregion
export { isSlackApprovalAuthorizedSender as t };
