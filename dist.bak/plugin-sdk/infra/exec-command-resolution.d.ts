import type { ExecAllowlistEntry } from "./exec-approvals.js";
export declare const DEFAULT_SAFE_BINS: string[];
export type CommandResolution = {
    rawExecutable: string;
    resolvedPath?: string;
    executableName: string;
    effectiveArgv?: string[];
    wrapperChain?: string[];
    policyBlocked?: boolean;
    blockedWrapper?: string;
};
export declare function resolveCommandResolution(command: string, cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
export declare function resolveCommandResolutionFromArgv(argv: string[], cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
export declare function resolveAllowlistCandidatePath(resolution: CommandResolution | null, cwd?: string): string | undefined;
export declare function matchAllowlist(entries: ExecAllowlistEntry[], resolution: CommandResolution | null): ExecAllowlistEntry | null;
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
