import { t as isApprovalNotFoundError } from "./approval-errors-DNzi1dia.js";
import "./error-runtime-BnVeBNYa.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-C33N9zkP.js";
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
