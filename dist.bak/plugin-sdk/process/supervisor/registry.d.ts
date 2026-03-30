import type { RunRecord, RunState, TerminationReason } from "./types.js";
export type RunRegistry = {
    add: (record: RunRecord) => void;
    get: (runId: string) => RunRecord | undefined;
    list: () => RunRecord[];
    listByScope: (scopeKey: string) => RunRecord[];
    updateState: (runId: string, state: RunState, patch?: Partial<Pick<RunRecord, "pid" | "terminationReason" | "exitCode" | "exitSignal">>) => RunRecord | undefined;
    touchOutput: (runId: string) => void;
    finalize: (runId: string, exit: {
        reason: TerminationReason;
        exitCode: number | null;
        exitSignal: NodeJS.Signals | number | null;
    }) => {
        record: RunRecord;
        firstFinalize: boolean;
    } | null;
    delete: (runId: string) => void;
};
export declare function createRunRegistry(options?: {
    maxExitedRecords?: number;
}): RunRegistry;
