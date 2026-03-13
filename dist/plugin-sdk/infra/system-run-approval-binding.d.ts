import type { SystemRunApprovalBinding, SystemRunApprovalPlan } from "./exec-approvals.js";
export declare function normalizeSystemRunApprovalPlan(value: unknown): SystemRunApprovalPlan | null;
export declare function buildSystemRunApprovalEnvBinding(env: unknown): {
    envHash: string | null;
    envKeys: string[];
};
export declare function buildSystemRunApprovalBinding(params: {
    argv: unknown;
    cwd?: unknown;
    agentId?: unknown;
    sessionKey?: unknown;
    env?: unknown;
}): {
    binding: SystemRunApprovalBinding;
    envKeys: string[];
};
export type SystemRunApprovalMatchResult = {
    ok: true;
} | {
    ok: false;
    code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
    message: string;
    details?: Record<string, unknown>;
};
type SystemRunApprovalMismatch = Extract<SystemRunApprovalMatchResult, {
    ok: false;
}>;
export declare function matchSystemRunApprovalEnvHash(params: {
    expectedEnvHash: string | null;
    actualEnvHash: string | null;
    actualEnvKeys: string[];
}): SystemRunApprovalMatchResult;
export declare function matchSystemRunApprovalBinding(params: {
    expected: SystemRunApprovalBinding;
    actual: SystemRunApprovalBinding;
    actualEnvKeys: string[];
}): SystemRunApprovalMatchResult;
export declare function missingSystemRunApprovalBinding(params: {
    actualEnvKeys: string[];
}): SystemRunApprovalMatchResult;
export declare function toSystemRunApprovalMismatchError(params: {
    runId: string;
    match: SystemRunApprovalMismatch;
}): {
    ok: false;
    message: string;
    details: Record<string, unknown>;
};
export {};
