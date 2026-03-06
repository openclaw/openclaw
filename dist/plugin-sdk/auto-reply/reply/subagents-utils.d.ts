import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
export declare function resolveSubagentLabel(entry: SubagentRunRecord, fallback?: string): string;
export declare function formatRunLabel(entry: SubagentRunRecord, options?: {
    maxLength?: number;
}): string;
export declare function formatRunStatus(entry: SubagentRunRecord): "timeout" | "unknown" | "error" | "done" | "running";
export declare function sortSubagentRuns(runs: SubagentRunRecord[]): SubagentRunRecord[];
export type SubagentTargetResolution = {
    entry?: SubagentRunRecord;
    error?: string;
};
export declare function resolveSubagentTargetFromRuns(params: {
    runs: SubagentRunRecord[];
    token: string | undefined;
    recentWindowMinutes: number;
    label: (entry: SubagentRunRecord) => string;
    errors: {
        missingTarget: string;
        invalidIndex: (value: string) => string;
        unknownSession: (value: string) => string;
        ambiguousLabel: (value: string) => string;
        ambiguousLabelPrefix: (value: string) => string;
        ambiguousRunIdPrefix: (value: string) => string;
        unknownTarget: (value: string) => string;
    };
}): SubagentTargetResolution;
