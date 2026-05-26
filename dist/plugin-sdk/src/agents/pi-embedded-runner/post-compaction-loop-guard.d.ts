import type { ToolLoopPostCompactionGuardConfig } from "../../config/types.tools.js";
export type PostCompactionGuardObservation = {
    toolName: string;
    argsHash: string;
    resultHash: string;
};
export type PostCompactionGuardVerdict = {
    shouldAbort: false;
    armed: boolean;
    remainingAttempts: number;
} | {
    shouldAbort: true;
    armed: boolean;
    remainingAttempts: number;
    detector: "compaction_loop_persisted";
    count: number;
    toolName: string;
    message: string;
};
export type PostCompactionLoopGuard = {
    armPostCompaction: () => void;
    observe: (call: PostCompactionGuardObservation) => PostCompactionGuardVerdict;
    snapshot: () => {
        armed: boolean;
        remainingAttempts: number;
    };
};
export declare function createPostCompactionLoopGuard(config?: ToolLoopPostCompactionGuardConfig, options?: {
    enabled?: boolean;
}): PostCompactionLoopGuard;
export declare class PostCompactionLoopPersistedError extends Error {
    readonly detector: "compaction_loop_persisted";
    readonly count: number;
    readonly toolName: string;
    constructor(message: string, details: {
        detector: "compaction_loop_persisted";
        count: number;
        toolName: string;
    });
    static fromVerdict(verdict: Extract<PostCompactionGuardVerdict, {
        shouldAbort: true;
    }>): PostCompactionLoopPersistedError;
}
