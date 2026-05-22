import type { ConfigValidationIssue } from "./types.js";
export type ConfigIssueLineInput = {
    path?: string | null;
    message: string;
};
type ConfigIssueFormatOptions = {
    normalizeRoot?: boolean;
};
type ConfigIssueSummaryOptions = ConfigIssueFormatOptions & {
    maxIssues?: number;
};
export declare function normalizeConfigIssuePath(path: string | null | undefined): string;
export declare function normalizeConfigIssue(issue: ConfigValidationIssue): ConfigValidationIssue;
export declare function normalizeConfigIssues(issues: ReadonlyArray<ConfigValidationIssue>): ConfigValidationIssue[];
export declare function formatConfigIssueLine(issue: ConfigIssueLineInput, marker?: string, opts?: ConfigIssueFormatOptions): string;
export declare function formatConfigIssueLines(issues: ReadonlyArray<ConfigIssueLineInput>, marker?: string, opts?: ConfigIssueFormatOptions): string[];
export declare function formatConfigIssueSummary(issues: ReadonlyArray<ConfigIssueLineInput>, opts?: ConfigIssueSummaryOptions): string | null;
export {};
