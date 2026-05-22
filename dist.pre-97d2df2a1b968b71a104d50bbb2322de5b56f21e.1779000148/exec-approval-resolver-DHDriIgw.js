import { t as isApprovalNotFoundError } from "./approval-errors-DVXay-B0.js";
import "./error-runtime-gRt9_CYh.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-vLAC0c5M.js";
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
