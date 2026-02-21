import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

export type RequestExecApprovalDecisionParams = {
  id: string;
  command: string;
  cwd: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
};

export async function requestExecApprovalDecision(
  params: RequestExecApprovalDecisionParams,
): Promise<string | null> {
  const decisionResult = await callGatewayTool<{ decision: string }>(
    "exec.approval.request",
    { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
    {
      id: params.id,
      command: params.command,
      cwd: params.cwd,
      host: params.host,
      security: params.security,
      ask: params.ask,
      agentId: params.agentId,
      resolvedPath: params.resolvedPath,
      sessionKey: params.sessionKey,
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    },
  );
  const decisionValue =
    decisionResult && typeof decisionResult === "object"
      ? (decisionResult as { decision?: unknown }).decision
      : undefined;
  return typeof decisionValue === "string" ? decisionValue : null;
}
