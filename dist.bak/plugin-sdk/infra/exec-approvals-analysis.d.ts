import { type CommandResolution } from "./exec-command-resolution.js";
export { DEFAULT_SAFE_BINS, matchAllowlist, parseExecArgvToken, resolveAllowlistCandidatePath, resolveCommandResolution, resolveCommandResolutionFromArgv, type CommandResolution, type ExecArgvToken, } from "./exec-command-resolution.js";
export type ExecCommandSegment = {
    raw: string;
    argv: string[];
    resolution: CommandResolution | null;
};
export type ExecCommandAnalysis = {
    ok: boolean;
    reason?: string;
    segments: ExecCommandSegment[];
    chains?: ExecCommandSegment[][];
};
export type ShellChainOperator = "&&" | "||" | ";";
export type ShellChainPart = {
    part: string;
    opToNext: ShellChainOperator | null;
};
export declare function isWindowsPlatform(platform?: string | null): boolean;
/**
 * Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
 * Returns null when no chain is present or when the chain is malformed.
 */
export declare function splitCommandChainWithOperators(command: string): ShellChainPart[] | null;
/**
 * Builds a shell command string that preserves pipes/chaining, but forces *arguments* to be
 * literal (no globbing, no env-var expansion) by single-quoting every argv token.
 *
 * Used to make "safe bins" actually stdin-only even though execution happens via `shell -c`.
 */
export declare function buildSafeShellCommand(params: {
    command: string;
    platform?: string | null;
}): {
    ok: boolean;
    command?: string;
    reason?: string;
};
/**
 * Rebuilds a shell command and selectively single-quotes argv tokens for segments that
 * must be treated as literal (safeBins hardening) while preserving the rest of the
 * shell syntax (pipes + chaining).
 */
export declare function buildSafeBinsShellCommand(params: {
    command: string;
    segments: ExecCommandSegment[];
    segmentSatisfiedBy: ("allowlist" | "safeBins" | "skills" | null)[];
    platform?: string | null;
}): {
    ok: boolean;
    command?: string;
    reason?: string;
};
export declare function buildEnforcedShellCommand(params: {
    command: string;
    segments: ExecCommandSegment[];
    platform?: string | null;
}): {
    ok: boolean;
    command?: string;
    reason?: string;
};
/**
 * Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
 * Returns null when no chain is present or when the chain is malformed.
 */
export declare function splitCommandChain(command: string): string[] | null;
export declare function analyzeShellCommand(params: {
    command: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
}): ExecCommandAnalysis;
export declare function analyzeArgvCommand(params: {
    argv: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis;
