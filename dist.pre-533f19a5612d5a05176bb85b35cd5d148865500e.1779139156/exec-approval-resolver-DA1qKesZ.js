import { t as isApprovalNotFoundError } from "./approval-errors-CVNTyNV7.js";
import "./error-runtime-BGv5yXC2.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-Bxbx-J_6.js";
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
