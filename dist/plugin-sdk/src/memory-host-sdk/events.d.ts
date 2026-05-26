import type { MemoryDreamingPhaseName } from "./dreaming.js";
export declare const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH: string;
export type MemoryHostRecallRecordedEvent = {
    type: "memory.recall.recorded";
    timestamp: string;
    query: string;
    resultCount: number;
    results: Array<{
        path: string;
        startLine: number;
        endLine: number;
        score: number;
    }>;
};
export type MemoryHostPromotionAppliedEvent = {
    type: "memory.promotion.applied";
    timestamp: string;
    memoryPath: string;
    applied: number;
    candidates: Array<{
        key: string;
        path: string;
        startLine: number;
        endLine: number;
        score: number;
        recallCount: number;
    }>;
};
export type MemoryHostDreamCompletedEvent = {
    type: "memory.dream.completed";
    timestamp: string;
    phase: MemoryDreamingPhaseName;
    inlinePath?: string;
    reportPath?: string;
    lineCount: number;
    storageMode: "inline" | "separate" | "both";
};
export type MemoryHostEvent = MemoryHostRecallRecordedEvent | MemoryHostPromotionAppliedEvent | MemoryHostDreamCompletedEvent;
export declare function resolveMemoryHostEventLogPath(workspaceDir: string): string;
export declare function appendMemoryHostEvent(workspaceDir: string, event: MemoryHostEvent): Promise<void>;
export declare function readMemoryHostEvents(params: {
    workspaceDir: string;
    limit?: number;
}): Promise<MemoryHostEvent[]>;
