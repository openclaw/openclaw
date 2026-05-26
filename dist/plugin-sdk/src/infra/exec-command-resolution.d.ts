import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
export type ExecutableResolution = {
    rawExecutable: string;
    resolvedPath?: string;
    resolvedRealPath?: string;
    executableName: string;
};
export type CommandResolution = {
    execution: ExecutableResolution;
    policy: ExecutableResolution;
    effectiveArgv?: string[];
    wrapperChain?: string[];
    policyBlocked?: boolean;
    blockedWrapper?: string;
};
export declare function resolveCommandResolution(command: string, cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
export declare function resolveCommandResolutionFromArgv(argv: string[], cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
export declare function resolveExecutionTargetResolution(resolution: CommandResolution | ExecutableResolution | null): ExecutableResolution | null;
export declare function resolvePolicyTargetResolution(resolution: CommandResolution | ExecutableResolution | null): ExecutableResolution | null;
export declare function resolveExecutionTargetCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
export declare function resolvePolicyTargetCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
export declare function resolveApprovalAuditCandidatePath(resolution: CommandResolution | null, cwd?: string): string | undefined;
/** @deprecated Use resolveExecutionTargetCandidatePath. */
export declare function resolveAllowlistCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
export declare function resolvePolicyAllowlistCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
export declare function matchAllowlist(entries: ExecAllowlistEntry[], resolution: ExecutableResolution | null, argv?: string[], platform?: string | null): ExecAllowlistEntry | null;
export type ExecArgvToken = {
    kind: "empty";
    raw: string;
} | {
    kind: "terminator";
    raw: string;
} | {
    kind: "stdin";
    raw: string;
} | {
    kind: "positional";
    raw: string;
} | {
    kind: "option";
    raw: string;
    style: "long";
    flag: string;
    inlineValue?: string;
} | {
    kind: "option";
    raw: string;
    style: "short-cluster";
    cluster: string;
    flags: string[];
};
/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
export declare function parseExecArgvToken(raw: string): ExecArgvToken;
