import type { AgentMessage } from "@mariozechner/pi-agent-core";
export type CompactionTimeoutSignal = {
    isTimeout: boolean;
    isCompactionPendingOrRetrying: boolean;
    isCompactionInFlight: boolean;
};
export declare function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean;
export declare function resolveRunTimeoutDuringCompaction(params: {
    isCompactionPendingOrRetrying: boolean;
    isCompactionInFlight: boolean;
    graceAlreadyUsed: boolean;
}): "extend" | "abort";
export declare function resolveRunTimeoutWithCompactionGraceMs(params: {
    runTimeoutMs: number;
    compactionTimeoutMs: number;
}): number;
export type SnapshotSelectionParams = {
    timedOutDuringCompaction: boolean;
    preCompactionSnapshot: AgentMessage[] | null;
    preCompactionSessionId: string;
    currentSnapshot: AgentMessage[];
    currentSessionId: string;
};
export type SnapshotSelection = {
    messagesSnapshot: AgentMessage[];
    sessionIdUsed: string;
    source: "pre-compaction" | "current";
};
export declare function selectCompactionTimeoutSnapshot(params: SnapshotSelectionParams): SnapshotSelection;
