import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/plugin-sdk/approval-auth-helpers.ts
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol("openclaw.implicitSameChatApprovalAuthorization");
function markImplicitSameChatApprovalAuthorization(result) {
	Object.defineProperty(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION, {
		value: true,
		enumerable: false
	});
	return result;
}
function isImplicitSameChatApprovalAuthorization(result) {
	return Boolean(result && result[IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION]);
}
function createResolvedApproverActionAuthAdapter(params) {
	const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;
	return { authorizeActorAction({ cfg, accountId, senderId, approvalKind }) {
		const approvers = params.resolveApprovers({
			cfg,
			accountId
		});
		if (approvers.length === 0) return markImplicitSameChatApprovalAuthorization({ authorized: true });
		const normalizedSenderId = senderId ? normalizeSenderId(senderId) : void 0;
		if (normalizedSenderId && approvers.includes(normalizedSenderId)) return { authorized: true };
		return {
			authorized: false,
			reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`
		};
	} };
}
//#endregion
export { isImplicitSameChatApprovalAuthorization as n, createResolvedApproverActionAuthAdapter as t };
