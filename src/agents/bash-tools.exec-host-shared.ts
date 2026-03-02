import {
  maxAsk,
  minSecurity,
  resolveExecApprovals,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { resolveRegisteredExecApprovalDecision } from "./bash-tools.exec-approval-request.js";

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;

export type ExecHostApprovalContext = {
  approvals: ResolvedExecApprovals;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
};

export function resolveExecHostApprovalContext(params: {
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  host: "gateway" | "node";
}): ExecHostApprovalContext {
  const approvals = resolveExecApprovals(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  const hostAsk = maxAsk(params.ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error(`exec denied: host=${params.host} security=deny`);
  }
  return { approvals, hostSecurity, hostAsk, askFallback };
}

export async function resolveApprovalDecisionOrUndefined(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
  onFailure: () => void;
}): Promise<string | null | undefined> {
  try {
    return await resolveRegisteredExecApprovalDecision({
      approvalId: params.approvalId,
      preResolvedDecision: params.preResolvedDecision,
    });
  } catch {
    params.onFailure();
    return undefined;
  }
}
