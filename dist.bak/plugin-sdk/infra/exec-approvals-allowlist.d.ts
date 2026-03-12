import { type ExecCommandAnalysis, type CommandResolution, type ExecCommandSegment } from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import { type SafeBinProfile } from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";
export declare function normalizeSafeBins(entries?: string[]): Set<string>;
export declare function resolveSafeBins(entries?: string[] | null): Set<string>;
export declare function isSafeBinUsage(params: {
    argv: string[];
    resolution: CommandResolution | null;
    safeBins: Set<string>;
    platform?: string | null;
    trustedSafeBinDirs?: ReadonlySet<string>;
    safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
    isTrustedSafeBinPathFn?: typeof isTrustedSafeBinPath;
}): boolean;
export type ExecAllowlistEvaluation = {
    allowlistSatisfied: boolean;
    allowlistMatches: ExecAllowlistEntry[];
    segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};
export type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | "skills" | null;
export type SkillBinTrustEntry = {
    name: string;
    resolvedPath: string;
};
export declare function evaluateExecAllowlist(params: {
    analysis: ExecCommandAnalysis;
    allowlist: ExecAllowlistEntry[];
    safeBins: Set<string>;
    safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
    cwd?: string;
    platform?: string | null;
    trustedSafeBinDirs?: ReadonlySet<string>;
    skillBins?: readonly SkillBinTrustEntry[];
    autoAllowSkills?: boolean;
}): ExecAllowlistEvaluation;
export type ExecAllowlistAnalysis = {
    analysisOk: boolean;
    allowlistSatisfied: boolean;
    allowlistMatches: ExecAllowlistEntry[];
    segments: ExecCommandSegment[];
    segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};
/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
export declare function resolveAllowAlwaysPatterns(params: {
    segments: ExecCommandSegment[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
}): string[];
/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export declare function evaluateShellAllowlist(params: {
    command: string;
    allowlist: ExecAllowlistEntry[];
    safeBins: Set<string>;
    safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    trustedSafeBinDirs?: ReadonlySet<string>;
    skillBins?: readonly SkillBinTrustEntry[];
    autoAllowSkills?: boolean;
    platform?: string | null;
}): ExecAllowlistAnalysis;
