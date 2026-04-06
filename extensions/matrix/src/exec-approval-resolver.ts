import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { withOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

export { isApprovalNotFoundError };

export async function resolveMatrixExecApproval(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
}): Promise<void> {
  await withOperatorApprovalsGatewayClient(
    {
      config: params.cfg,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: `Matrix approval (${params.senderId?.trim() || "unknown"})`,
    },
    async (gatewayClient) => {
      await gatewayClient.request("exec.approval.resolve", {
        id: params.approvalId,
        decision: params.decision,
      });
    },
  );
}
