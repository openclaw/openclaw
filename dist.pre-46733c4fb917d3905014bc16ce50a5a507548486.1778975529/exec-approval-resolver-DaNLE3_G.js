import { t as isApprovalNotFoundError } from "./approval-errors-DVXay-B0.js";
import "./error-runtime-C3sYM99G.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-CA58Z4TD.js";
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
