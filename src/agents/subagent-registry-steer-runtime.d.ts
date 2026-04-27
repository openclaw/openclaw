import type { SubagentRunRecord } from "./subagent-registry.types.js";
export type ReplaceSubagentRunAfterSteerParams = {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
};
type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;
type FinalizeInterruptedSubagentRunParams = {
    runId?: string;
    childSessionKey?: string;
    error: string;
    endedAt?: number;
};
type FinalizeInterruptedSubagentRunFn = (params: FinalizeInterruptedSubagentRunParams) => Promise<number>;
export declare function configureSubagentRegistrySteerRuntime(params: {
    replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
    finalizeInterruptedSubagentRun?: FinalizeInterruptedSubagentRunFn;
}): void;
export declare function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams): boolean;
export declare function finalizeInterruptedSubagentRun(params: FinalizeInterruptedSubagentRunParams): Promise<number>;
export {};
