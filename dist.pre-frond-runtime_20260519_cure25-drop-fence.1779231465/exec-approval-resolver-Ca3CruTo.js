import { t as isApprovalNotFoundError } from "./approval-errors-DK7j1Lg4.js";
import "./error-runtime-B4bLKqjn.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-DkSXGd0a.js";
//#region extensions/matrix/src/exec-approval-resolver.ts
async function resolveMatrixApproval(params) {
	await resolveApprovalOverGateway({
		cfg: params.cfg,
		approvalId: params.approvalId,
		decision: params.decision,
		senderId: params.senderId,
		gatewayUrl: params.gatewayUrl,
		clientDisplayName: `Matrix approval (${params.senderId?.trim() || "unknown"})`
	});
}
//#endregion
export { isApprovalNotFoundError, resolveMatrixApproval };
