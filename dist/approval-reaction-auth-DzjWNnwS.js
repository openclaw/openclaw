import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { i as resolveMatrixAccount } from "./accounts-CAjG_HwT.js";
import { t as normalizeMatrixApproverId } from "./approval-ids-DC3o8pCu.js";
//#region extensions/matrix/src/approval-reaction-auth.ts
function normalizeMatrixExecApproverId(value) {
	const normalized = normalizeMatrixApproverId(value);
	return normalized === "*" ? void 0 : normalized;
}
function getMatrixApprovalReactionApprovers(params) {
	const account = resolveMatrixAccount(params).config;
	if (params.approvalKind === "plugin") return resolveApprovalApprovers({
		allowFrom: account.dm?.allowFrom,
		normalizeApprover: normalizeMatrixApproverId
	});
	return resolveApprovalApprovers({
		explicit: account.execApprovals?.approvers,
		allowFrom: account.dm?.allowFrom,
		normalizeApprover: normalizeMatrixExecApproverId
	});
}
function isMatrixApprovalReactionAuthorizedSender(params) {
	const normalizedSenderId = params.senderId ? normalizeMatrixApproverId(params.senderId) : void 0;
	if (!normalizedSenderId) return false;
	return getMatrixApprovalReactionApprovers(params).includes(normalizedSenderId);
}
//#endregion
export { isMatrixApprovalReactionAuthorizedSender };
