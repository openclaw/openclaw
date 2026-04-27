import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
export declare const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85;
export declare const DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES = 3;
export declare const DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX = 32;
export type BootstrapTruncationCause = "per-file-limit" | "total-limit";
export type BootstrapPromptWarningMode = "off" | "once" | "always";
export type BootstrapInjectionStat = {
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
};
export type BootstrapAnalyzedFile = BootstrapInjectionStat & {
    nearLimit: boolean;
    causes: BootstrapTruncationCause[];
};
export type BootstrapBudgetAnalysis = {
    files: BootstrapAnalyzedFile[];
    truncatedFiles: BootstrapAnalyzedFile[];
    nearLimitFiles: BootstrapAnalyzedFile[];
    totalNearLimit: boolean;
    hasTruncation: boolean;
    totals: {
        rawChars: number;
        injectedChars: number;
        truncatedChars: number;
        bootstrapMaxChars: number;
        bootstrapTotalMaxChars: number;
        nearLimitRatio: number;
    };
};
export type BootstrapPromptWarning = {
    signature?: string;
    warningShown: boolean;
    lines: string[];
    warningSignaturesSeen: string[];
};
export type BootstrapTruncationReportMeta = {
    warningMode: BootstrapPromptWarningMode;
    warningShown: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles: number;
    nearLimitFiles: number;
    totalNearLimit: boolean;
};
export declare function resolveBootstrapWarningSignaturesSeen(report?: {
    bootstrapTruncation?: {
        warningMode?: BootstrapPromptWarningMode;
        warningSignaturesSeen?: string[];
        promptWarningSignature?: string;
    };
}): string[];
export declare function buildBootstrapInjectionStats(params: {
    bootstrapFiles: WorkspaceBootstrapFile[];
    injectedFiles: EmbeddedContextFile[];
}): BootstrapInjectionStat[];
export declare function analyzeBootstrapBudget(params: {
    files: BootstrapInjectionStat[];
    bootstrapMaxChars: number;
    bootstrapTotalMaxChars: number;
    nearLimitRatio?: number;
}): BootstrapBudgetAnalysis;
export declare function buildBootstrapTruncationSignature(analysis: BootstrapBudgetAnalysis): string | undefined;
export declare function formatBootstrapTruncationWarningLines(params: {
    analysis: BootstrapBudgetAnalysis;
    maxFiles?: number;
}): string[];
export declare function buildBootstrapPromptWarning(params: {
    analysis: BootstrapBudgetAnalysis;
    mode: BootstrapPromptWarningMode;
    previousSignature?: string;
    seenSignatures?: string[];
    maxFiles?: number;
}): BootstrapPromptWarning;
export declare function appendBootstrapPromptWarning(prompt: string, warningLines?: string[], options?: {
    preserveExactPrompt?: string;
}): string;
export declare const prependBootstrapPromptWarning: typeof appendBootstrapPromptWarning;
export declare function buildBootstrapTruncationReportMeta(params: {
    analysis: BootstrapBudgetAnalysis;
    warningMode: BootstrapPromptWarningMode;
    warning: BootstrapPromptWarning;
}): BootstrapTruncationReportMeta;
