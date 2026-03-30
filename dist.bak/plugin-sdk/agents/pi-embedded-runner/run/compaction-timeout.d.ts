import type { AgentMessage } from "@mariozechner/pi-agent-core";
export type CompactionTimeoutSignal = {
    isTimeout: boolean;
    isCompactionPendingOrRetrying: boolean;
    isCompactionInFlight: boolean;
};
export declare function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean;
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
