import { t as isApprovalNotFoundError } from "./approval-errors-Bu6UZO7c.js";
import { n as withOperatorApprovalsGatewayClient } from "./operator-approvals-client-BuvA9obS.js";
//#region src/infra/approval-gateway-resolver.ts
async function resolveApprovalOverGateway(params) {
	await withOperatorApprovalsGatewayClient({
		config: params.cfg,
		gatewayUrl: params.gatewayUrl,
		clientDisplayName: params.clientDisplayName ?? `Approval (${params.senderId?.trim() || "unknown"})`
	}, async (gatewayClient) => {
		const requestResolve = async (method) => {
			await gatewayClient.request(method, {
				id: params.approvalId,
				decision: params.decision
			});
		};
		if (params.approvalId.startsWith("plugin:")) {
			await requestResolve("plugin.approval.resolve");
			return;
		}
		try {
			await requestResolve("exec.approval.resolve");
		} catch (err) {
			if (!params.allowPluginFallback || !isApprovalNotFoundError(err)) throw err;
			await requestResolve("plugin.approval.resolve");
		}
	});
}
//#endregion
export { resolveApprovalOverGateway as t };
