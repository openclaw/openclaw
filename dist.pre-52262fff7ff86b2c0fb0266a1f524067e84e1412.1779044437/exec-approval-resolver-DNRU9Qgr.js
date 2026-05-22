import { t as isApprovalNotFoundError } from "./approval-errors-C6TtcJgZ.js";
import "./error-runtime-6MsWMbna.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-JEIEC_Nh.js";
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
