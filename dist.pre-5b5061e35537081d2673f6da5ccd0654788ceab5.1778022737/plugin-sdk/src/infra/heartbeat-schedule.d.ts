export declare function resolveHeartbeatPhaseMs(params: {
    schedulerSeed: string;
    agentId: string;
    intervalMs: number;
}): number;
export declare function computeNextHeartbeatPhaseDueMs(params: {
    nowMs: number;
    intervalMs: number;
    phaseMs: number;
}): number;
export declare function resolveNextHeartbeatDueMs(params: {
    nowMs: number;
    intervalMs: number;
    phaseMs: number;
    prev?: {
        intervalMs: number;
        phaseMs: number;
        nextDueMs: number;
    };
}): number;
export declare function seekNextActivePhaseDueMs(params: {
    startMs: number;
    intervalMs: number;
    phaseMs: number;
    isActive?: (ms: number) => boolean;
}): number;
