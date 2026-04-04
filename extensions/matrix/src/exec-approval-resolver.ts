import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readApprovalNotFoundDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_NOT_FOUND) {
    return true;
  }
  return /unknown or expired approval id/i.test(err.message);
}

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
