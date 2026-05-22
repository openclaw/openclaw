import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import { type ExecAsk, type ExecSecurity, type SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
type NodeExecutionTarget = {
    nodeId: string;
    platform?: string | null;
    argv: string[];
    env: Record<string, string> | undefined;
    invokeTimeoutMs: number;
    runTimeoutSec: number;
    supportsSystemRunPrepare: boolean;
};
type PreparedNodeRun = {
    plan: SystemRunApprovalPlan;
    argv: string[];
    rawCommand: string;
    cwd: string | undefined;
    agentId: string | undefined;
    sessionKey: string | undefined;
};
type NodeApprovalAnalysis = {
    analysisOk: boolean;
    allowlistSatisfied: boolean;
    durableApprovalSatisfied: boolean;
    inlineEvalHit: InterpreterInlineEvalHit | null;
};
export declare function shouldSkipNodeApprovalPrepare(params: {
    hostSecurity: ExecSecurity;
    hostAsk: ExecAsk;
    strictInlineEval?: boolean;
}): boolean;
export declare function formatNodeRunToolResult(params: {
    raw: unknown;
    startedAt: number;
    cwd: string | undefined;
}): AgentToolResult<ExecToolDetails>;
export declare function resolveNodeExecutionTarget(params: ExecuteNodeHostCommandParams): Promise<NodeExecutionTarget>;
export declare function buildNodeSystemRunInvoke(params: {
    target: NodeExecutionTarget;
    command: string[];
    rawCommand: string;
    cwd: string | undefined;
    agentId: string | undefined;
    sessionKey: string | undefined;
    approved?: boolean;
    approvalDecision?: "allow-once" | "allow-always" | null;
    runId?: string;
    suppressNotifyOnExit?: boolean;
    notifyOnExit?: boolean;
    systemRunPlan?: SystemRunApprovalPlan;
}): Record<string, unknown>;
export declare function invokeNodeSystemRunDirect(params: {
    request: ExecuteNodeHostCommandParams;
    target: NodeExecutionTarget;
}): Promise<AgentToolResult<ExecToolDetails>>;
export declare function prepareNodeSystemRun(params: {
    request: ExecuteNodeHostCommandParams;
    target: NodeExecutionTarget;
}): Promise<PreparedNodeRun>;
export declare function analyzeNodeApprovalRequirement(params: {
    request: ExecuteNodeHostCommandParams;
    target: NodeExecutionTarget;
    prepared: PreparedNodeRun;
    hostSecurity: ExecSecurity;
    hostAsk: ExecAsk;
}): Promise<NodeApprovalAnalysis>;
export {};
