import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/infra-runtime";

export type ResolveTelegramExecApprovalParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
};

export async function resolveTelegramExecApproval(
  params: ResolveTelegramExecApprovalParams,
): Promise<void> {
  const isApprovalNotFoundError = (err: unknown): boolean => {
    if (!(err instanceof Error)) {
      return false;
    }
    const gatewayCode = (err as { gatewayCode?: unknown }).gatewayCode;
    if (gatewayCode === "APPROVAL_NOT_FOUND") {
      return true;
    }
    const details = (err as { details?: unknown }).details;
    if (
      gatewayCode === "INVALID_REQUEST" &&
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      (details as { reason?: unknown }).reason === "APPROVAL_NOT_FOUND"
    ) {
      return true;
    }
    return /unknown or expired approval id/i.test(err.message);
  };

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
    clientDisplayName: `Telegram approval (${params.senderId?.trim() || "unknown"})`,
    onHelloOk: () => {
      markReady();
    },
    onConnectError: (err) => {
      failReady(err);
    },
    onClose: (code, reason) => {
      // Once onHelloOk resolves `ready`, in-flight request failures must come from
      // gatewayClient.request() itself; failReady only covers the pre-ready phase.
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    gatewayClient.start();
    await ready;
    const requestApproval = async (method: "exec.approval.resolve" | "plugin.approval.resolve") => {
      await gatewayClient.request(method, {
        id: params.approvalId,
        decision: params.decision,
      });
    };
    if (params.approvalId.startsWith("plugin:")) {
      await requestApproval("plugin.approval.resolve");
    } else {
      try {
        await requestApproval("exec.approval.resolve");
      } catch (err) {
        if (!isApprovalNotFoundError(err)) {
          throw err;
        }
        await requestApproval("plugin.approval.resolve");
      }
    }
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
