import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>): void;
export declare function restoreSubagentRunsFromDisk(params: {
    runs: Map<string, SubagentRunRecord>;
    mergeOnly?: boolean;
}): number;
export declare function getSubagentRunsSnapshotForRead(inMemoryRuns: Map<string, SubagentRunRecord>): Map<string, SubagentRunRecord>;
