import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { c as buildPluginApprovalRequestMessage, l as buildPluginApprovalResolvedMessage, u as resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals-D_CR4ZcB.js";
import { t as buildApprovalInteractiveReply } from "./exec-approval-reply-EV2HWtya.js";
//#region src/plugin-sdk/approval-renderers.ts
const DEFAULT_ALLOWED_DECISIONS = [
	"allow-once",
	"allow-always",
	"deny"
];
function buildApprovalPendingReplyPayload(params) {
	const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
	return {
		text: params.text,
		interactive: buildApprovalInteractiveReply({
			approvalId: params.approvalId,
			allowedDecisions
		}),
		channelData: {
			execApproval: {
				approvalId: params.approvalId,
				approvalSlug: params.approvalSlug,
				approvalKind: params.approvalKind ?? "exec",
				agentId: normalizeOptionalString(params.agentId),
				allowedDecisions,
				sessionKey: normalizeOptionalString(params.sessionKey),
				state: "pending"
			},
			...params.channelData
		}
	};
}
function buildApprovalResolvedReplyPayload(params) {
	return {
		text: params.text,
		channelData: {
			execApproval: {
				approvalId: params.approvalId,
				approvalSlug: params.approvalSlug,
				state: "resolved"
			},
			...params.channelData
		}
	};
}
function buildPluginApprovalPendingReplyPayload(params) {
	return buildApprovalPendingReplyPayload({
		approvalKind: "plugin",
		approvalId: params.request.id,
		approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
		text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
		allowedDecisions: params.allowedDecisions ?? resolvePluginApprovalRequestAllowedDecisions(params.request.request),
		channelData: params.channelData
	});
}
function buildPluginApprovalResolvedReplyPayload(params) {
	return buildApprovalResolvedReplyPayload({
		approvalId: params.resolved.id,
		approvalSlug: params.approvalSlug ?? params.resolved.id.slice(0, 8),
		text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
		channelData: params.channelData
	});
}
//#endregion
export { buildPluginApprovalResolvedReplyPayload as i, buildApprovalResolvedReplyPayload as n, buildPluginApprovalPendingReplyPayload as r, buildApprovalPendingReplyPayload as t };
