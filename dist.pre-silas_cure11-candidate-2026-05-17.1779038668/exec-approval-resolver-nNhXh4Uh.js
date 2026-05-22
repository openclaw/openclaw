import { t as isApprovalNotFoundError } from "./approval-errors-Dbol6qBY.js";
import "./error-runtime-C2O_0klE.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-De36A8BA.js";
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
