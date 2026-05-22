import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";
export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecTarget = "auto" | ExecHost;
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";
export declare const EXEC_TARGET_VALUES: readonly ExecTarget[];
export declare function normalizeExecHost(value?: string | null): ExecHost | null;
export declare function normalizeExecTarget(value?: string | null): ExecTarget | null;
export declare function requireValidExecTarget(value?: unknown): ExecTarget | null;
export declare function normalizeExecSecurity(value?: string | null): ExecSecurity | null;
export declare function normalizeExecAsk(value?: string | null): ExecAsk | null;
export type SystemRunApprovalBinding = {
    argv: string[];
    cwd: string | null;
    agentId: string | null;
    sessionKey: string | null;
    envHash: string | null;
};
export type SystemRunApprovalFileOperand = {
    argvIndex: number;
    path: string;
    sha256: string;
};
export type SystemRunApprovalPlan = {
    argv: string[];
    cwd: string | null;
    commandText: string;
    commandPreview?: string | null;
    agentId: string | null;
    sessionKey: string | null;
    mutableFileOperand?: SystemRunApprovalFileOperand | null;
};
export type ExecApprovalRequestPayload = {
    command: string;
    commandPreview?: string | null;
    commandArgv?: string[];
    envKeys?: string[];
    systemRunBinding?: SystemRunApprovalBinding | null;
    systemRunPlan?: SystemRunApprovalPlan | null;
    cwd?: string | null;
    nodeId?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    warningText?: string | null;
    allowedDecisions?: readonly ExecApprovalDecision[];
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    turnSourceChannel?: string | null;
    turnSourceTo?: string | null;
    turnSourceAccountId?: string | null;
    turnSourceThreadId?: string | number | null;
};
export type ExecApprovalRequest = {
    id: string;
    request: ExecApprovalRequestPayload;
    createdAtMs: number;
    expiresAtMs: number;
};
export type ExecApprovalResolved = {
    id: string;
    decision: ExecApprovalDecision;
    resolvedBy?: string | null;
    ts: number;
    request?: ExecApprovalRequest["request"];
};
export type ExecApprovalsDefaults = {
    security?: ExecSecurity;
    ask?: ExecAsk;
    askFallback?: ExecSecurity;
    autoAllowSkills?: boolean;
};
export type ExecApprovalsAgent = ExecApprovalsDefaults & {
    allowlist?: ExecAllowlistEntry[];
};
export type ExecApprovalsFile = {
    version: 1;
    socket?: {
        path?: string;
        token?: string;
    };
    defaults?: ExecApprovalsDefaults;
    agents?: Record<string, ExecApprovalsAgent>;
};
export type ExecApprovalsSnapshot = {
    path: string;
    exists: boolean;
    raw: string | null;
    file: ExecApprovalsFile;
    hash: string;
};
export type ExecApprovalsResolved = {
    path: string;
    socketPath: string;
    token: string;
    defaults: Required<ExecApprovalsDefaults>;
    agent: Required<ExecApprovalsDefaults>;
    agentSources: {
        security: string | null;
        ask: string | null;
        askFallback: string | null;
    };
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
};
export declare const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1800000;
export declare const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity;
export declare function resolveExecApprovalsPath(): string;
export declare function resolveExecApprovalsSocketPath(): string;
export declare function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile;
export declare function mergeExecApprovalsSocketDefaults(params: {
    normalized: ExecApprovalsFile;
    current?: ExecApprovalsFile;
}): ExecApprovalsFile;
export declare function readExecApprovalsSnapshot(): ExecApprovalsSnapshot;
export declare function loadExecApprovals(): ExecApprovalsFile;
export declare function saveExecApprovals(file: ExecApprovalsFile): void;
export declare function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void;
export declare function ensureExecApprovals(): ExecApprovalsFile;
export type ExecApprovalsDefaultOverrides = {
    security?: ExecSecurity;
    ask?: ExecAsk;
    askFallback?: ExecSecurity;
    autoAllowSkills?: boolean;
};
export declare function resolveExecApprovals(agentId?: string, overrides?: ExecApprovalsDefaultOverrides): ExecApprovalsResolved;
export declare function resolveExecApprovalsFromFile(params: {
    file: ExecApprovalsFile;
    agentId?: string;
    overrides?: ExecApprovalsDefaultOverrides;
    path?: string;
    socketPath?: string;
    token?: string;
}): ExecApprovalsResolved;
export declare function requiresExecApproval(params: {
    ask: ExecAsk;
    security: ExecSecurity;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
    durableApprovalSatisfied?: boolean;
}): boolean;
export declare function hasDurableExecApproval(params: {
    analysisOk: boolean;
    segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
    allowlist?: readonly ExecAllowlistEntry[];
    commandText?: string | null;
}): boolean;
export declare function recordAllowlistUse(approvals: ExecApprovalsFile, agentId: string | undefined, entry: ExecAllowlistEntry, command: string, resolvedPath?: string): void;
export declare function recordAllowlistMatchesUse(params: {
    approvals: ExecApprovalsFile;
    agentId: string | undefined;
    matches: readonly ExecAllowlistEntry[];
    command: string;
    resolvedPath?: string;
}): void;
export declare function addAllowlistEntry(approvals: ExecApprovalsFile, agentId: string | undefined, pattern: string, options?: {
    argPattern?: string;
    source?: ExecAllowlistEntry["source"];
}): void;
export declare function addDurableCommandApproval(approvals: ExecApprovalsFile, agentId: string | undefined, commandText: string): void;
export declare function persistAllowAlwaysPatterns(params: {
    approvals: ExecApprovalsFile;
    agentId: string | undefined;
    segments: ExecCommandSegment[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
    strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries>;
export declare function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity;
export declare function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk;
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
export declare const DEFAULT_EXEC_APPROVAL_DECISIONS: readonly ["allow-once", "allow-always", "deny"];
export declare function resolveExecApprovalAllowedDecisions(params?: {
    ask?: string | null;
}): readonly ExecApprovalDecision[];
export declare function resolveExecApprovalRequestAllowedDecisions(params?: {
    ask?: string | null;
    allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[];
export declare function isExecApprovalDecisionAllowed(params: {
    decision: ExecApprovalDecision;
    ask?: string | null;
}): boolean;
export declare function requestExecApprovalViaSocket(params: {
    socketPath: string;
    token: string;
    request: Record<string, unknown>;
    timeoutMs?: number;
}): Promise<ExecApprovalDecision | null>;
