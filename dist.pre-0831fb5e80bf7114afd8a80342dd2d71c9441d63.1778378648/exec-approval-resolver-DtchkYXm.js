import { t as isApprovalNotFoundError } from "./approval-errors-Bu6UZO7c.js";
import "./error-runtime-CEjhuOxx.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-CgPYYHC7.js";
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
