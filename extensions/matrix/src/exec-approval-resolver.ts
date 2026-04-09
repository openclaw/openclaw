import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

export { isApprovalNotFoundError };

export async function resolveMatrixExecApproval(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
}): Promise<void> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    config: params.cfg,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: `Matrix approval (${params.senderId?.trim() || "unknown"})`,
    onHelloOk: () => {
      markReady();
    },
    onConnectError: (err) => {
      failReady(err);
    },
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    gatewayClient.start();
    await ready;
    await gatewayClient.request("exec.approval.resolve", {
      id: params.approvalId,
      decision: params.decision,
    });
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
