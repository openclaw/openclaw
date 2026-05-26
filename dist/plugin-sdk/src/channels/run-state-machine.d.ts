type RunStateStatusPatch = {
    busy?: boolean;
    activeRuns?: number;
    lastRunActivityAt?: number | null;
};
export type RunStateStatusSink = (patch: RunStateStatusPatch) => void;
type RunStateMachineParams = {
    setStatus?: RunStateStatusSink;
    abortSignal?: AbortSignal;
    heartbeatMs?: number;
    now?: () => number;
};
export declare function createRunStateMachine(params: RunStateMachineParams): {
    isActive(): boolean;
    onRunStart(): void;
    onRunEnd(): void;
    deactivate: () => void;
};
export {};
