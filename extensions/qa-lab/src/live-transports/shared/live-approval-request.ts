import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { QaGatewayChild } from "../../gateway-child.js";
import {
  formatApprovalResultValue,
  readAcceptedApprovalRequestId,
} from "./live-approval-result.js";

export async function requestLiveQaApproval(params: {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  channel: "slack" | "whatsapp";
  gateway: Pick<QaGatewayChild, "call">;
  sutAccountId: string;
  timeoutMs: number;
  token: string;
  turnSourceTo: string;
}) {
  const commonParams = {
    timeoutMs: params.timeoutMs,
    turnSourceAccountId: params.sutAccountId,
    turnSourceChannel: params.channel,
    turnSourceTo: params.turnSourceTo,
    twoPhase: true,
  };
  const options = { expectFinal: false, timeoutMs: params.timeoutMs + 5_000 };
  if (params.approvalKind === "exec") {
    const result = await params.gateway.call(
      "exec.approval.request",
      {
        ...commonParams,
        ask: "always",
        command: `printf '%s\\n' '${params.token}'`,
        host: "gateway",
        id: params.approvalId,
        security: "full",
      },
      options,
    );
    const acceptedId = readAcceptedApprovalRequestId(result);
    if (acceptedId !== params.approvalId) {
      throw new Error(
        `accepted exec approval id was ${formatApprovalResultValue(acceptedId)} instead of ${params.approvalId}`,
      );
    }
    return acceptedId;
  }
  const label = params.channel === "slack" ? "Slack" : "WhatsApp";
  const result = await params.gateway.call(
    "plugin.approval.request",
    {
      ...commonParams,
      agentId: "qa",
      description: `${label} plugin approval QA request ${params.token}`,
      pluginId: `qa-${params.channel}-plugin`,
      severity: "warning",
      title: `${label} plugin approval QA ${params.token}`,
      toolName: `${params.channel}_qa_tool`,
    },
    options,
  );
  return readAcceptedApprovalRequestId(result);
}
