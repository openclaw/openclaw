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
export declare const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE: {
    readonly workspace: "attempt-workspace";
    readonly prompt: "attempt-prompt";
    readonly runtimePlan: "attempt-runtime-plan";
    readonly dispatch: "attempt-dispatch";
};
export declare function createEmbeddedRunStageTracker(options?: {
    now?: () => number;
}): EmbeddedRunStageTracker;
export declare function shouldWarnEmbeddedRunStageSummary(summary: EmbeddedRunStageSummary, options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
}): boolean;
export declare function formatEmbeddedRunStageSummary(prefix: string, summary: EmbeddedRunStageSummary): string;
