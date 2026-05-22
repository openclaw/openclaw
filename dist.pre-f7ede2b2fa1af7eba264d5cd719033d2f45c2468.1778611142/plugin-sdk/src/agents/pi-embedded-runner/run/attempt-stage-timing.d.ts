export type EmbeddedRunStageTiming = {
    name: string;
    durationMs: number;
    elapsedMs: number;
};
export type EmbeddedRunStageSummary = {
    totalMs: number;
    stages: EmbeddedRunStageTiming[];
};
export type EmbeddedRunStageTracker = {
    mark: (name: string) => void;
    snapshot: () => EmbeddedRunStageSummary;
};
export declare function createEmbeddedRunStageTracker(options?: {
    now?: () => number;
}): EmbeddedRunStageTracker;
export declare function shouldWarnEmbeddedRunStageSummary(summary: EmbeddedRunStageSummary, options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
}): boolean;
export declare function formatEmbeddedRunStageSummary(prefix: string, summary: EmbeddedRunStageSummary): string;
