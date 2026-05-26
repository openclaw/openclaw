export declare const NODE_WAKE_RECONNECT_WAIT_MS = 3000;
export declare const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12000;
export declare const NODE_WAKE_RECONNECT_POLL_MS = 150;
export type NodeWakeAttempt = {
    available: boolean;
    throttled: boolean;
    path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
    durationMs: number;
    apnsStatus?: number;
    apnsReason?: string;
};
type NodeWakeState = {
    lastWakeAtMs: number;
    inFlight?: Promise<NodeWakeAttempt>;
};
export declare const nodeWakeById: Map<string, NodeWakeState>;
export declare const nodeWakeNudgeById: Map<string, number>;
export declare function clearNodeWakeState(nodeId: string): void;
export declare const testing: {
    getNodeWakeByIdSize(): number;
    hasNodeWakeEntry(nodeId: string): boolean;
    resetWakeState(): void;
};
export { testing as __testing };
