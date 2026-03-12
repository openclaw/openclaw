export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";
export type SystemRunApprovalBindingV1 = {
    version: 1;
    argv: string[];
    cwd: string | null;
    agentId: string | null;
    sessionKey: string | null;
    envHash: string | null;
};
export type SystemRunApprovalPlanV2 = {
    version: 2;
    argv: string[];
    cwd: string | null;
    rawCommand: string | null;
    agentId: string | null;
    sessionKey: string | null;
};
export type ExecApprovalRequestPayload = {
    command: string;
    commandArgv?: string[];
    envKeys?: string[];
    systemRunBindingV1?: SystemRunApprovalBindingV1 | null;
    systemRunPlanV2?: SystemRunApprovalPlanV2 | null;
    cwd?: string | null;
    nodeId?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
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
export type ExecAllowlistEntry = {
    id?: string;
    pattern: string;
    lastUsedAt?: number;
    lastUsedCommand?: string;
    lastResolvedPath?: string;
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
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
};
export declare const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120000;
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
}): boolean;
export declare function recordAllowlistUse(approvals: ExecApprovalsFile, agentId: string | undefined, entry: ExecAllowlistEntry, command: string, resolvedPath?: string): void;
export declare function addAllowlistEntry(approvals: ExecApprovalsFile, agentId: string | undefined, pattern: string): void;
export declare function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity;
export declare function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk;
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
export declare function requestExecApprovalViaSocket(params: {
    socketPath: string;
    token: string;
    request: Record<string, unknown>;
    timeoutMs?: number;
}): Promise<ExecApprovalDecision | null>;
