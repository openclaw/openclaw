import crypto from "node:crypto";
import {
  maxAsk,
  minSecurity,
  resolveExecApprovals,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { resolveRegisteredExecApprovalDecision } from "./bash-tools.exec-approval-request.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";

type ResolvedExecApprovals = ReturnType<typeof resolveExecApprovals>;

export type ExecHostApprovalContext = {
  approvals: ResolvedExecApprovals;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
};

export type ExecApprovalPendingState = {
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
};

export type ExecApprovalRequestState = ExecApprovalPendingState & {
  noticeSeconds: number;
};

export function createExecApprovalPendingState(params: {
  warnings: string[];
  timeoutMs: number;
}): ExecApprovalPendingState {
  return {
    warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
    expiresAtMs: Date.now() + params.timeoutMs,
    preResolvedDecision: undefined,
  };
}

export function createExecApprovalRequestState(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
}): ExecApprovalRequestState {
  const pendingState = createExecApprovalPendingState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
  });
  return {
    ...pendingState,
    noticeSeconds: Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000)),
  };
}

export function createExecApprovalRequestContext(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalRequestState & {
  approvalId: string;
  approvalSlug: string;
  contextKey: string;
} {
  const approvalId = crypto.randomUUID();
  const pendingState = createExecApprovalRequestState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
  });
  return {
    ...pendingState,
    approvalId,
    approvalSlug: params.createApprovalSlug(approvalId),
    contextKey: `exec:${approvalId}`,
  };
}

export function createDefaultExecApprovalRequestContext(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}) {
  return createExecApprovalRequestContext({
    warnings: params.warnings,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
  });
}

export function resolveBaseExecApprovalDecision(params: {
  decision: string | null;
  askFallback: ResolvedExecApprovals["agent"]["askFallback"];
  obfuscationDetected: boolean;
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timedOut: boolean;
} {
  if (params.decision === "deny") {
    return { approvedByAsk: false, deniedReason: "user-denied", timedOut: false };
  }
  if (!params.decision) {
    if (params.obfuscationDetected) {
      return {
        approvedByAsk: false,
        deniedReason: "approval-timeout (obfuscation-detected)",
        timedOut: true,
      };
    }
    if (params.askFallback === "full") {
      return { approvedByAsk: true, deniedReason: null, timedOut: true };
    }
    if (params.askFallback === "deny") {
      return { approvedByAsk: false, deniedReason: "approval-timeout", timedOut: true };
    }
    return { approvedByAsk: false, deniedReason: null, timedOut: true };
  }
  return { approvedByAsk: false, deniedReason: null, timedOut: false };
}

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
  // An explicit ask=off policy in exec-approvals.json must be able to suppress
  // prompts even when tool/runtime defaults are stricter (for example on-miss).
  const hostAsk = approvals.agent.ask === "off" ? "off" : maxAsk(params.ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  // Note: callers that support trust-window overrides must check deny themselves
  // after evaluating trust state. Don't throw here — return the resolved context.
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
