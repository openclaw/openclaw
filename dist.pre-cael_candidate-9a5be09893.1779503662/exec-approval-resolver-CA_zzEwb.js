import { t as isApprovalNotFoundError } from "./approval-errors-s6AXlG1x.js";
import "./error-runtime-Dgkgdgpq.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-resolver-C2gv8qBZ.js";
import "./approval-gateway-runtime-D_hlo6Z_.js";
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
