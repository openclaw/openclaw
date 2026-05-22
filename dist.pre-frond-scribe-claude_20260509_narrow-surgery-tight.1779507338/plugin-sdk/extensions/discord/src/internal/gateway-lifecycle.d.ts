type GatewayTimer = NodeJS.Timeout;
export declare class GatewayHeartbeatTimers {
    heartbeatInterval?: GatewayTimer;
    firstHeartbeatTimeout?: GatewayTimer;
    private scheduleHeartbeatCycle;
    start(params: {
        intervalMs: number;
        isAcked: () => boolean;
        onAckTimeout: () => void;
        onHeartbeat: () => void;
        random?: () => number;
    }): void;
    stop(): void;
}
export declare class GatewayReconnectTimer {
    timeout?: GatewayTimer;
    stop(): void;
    schedule(delayMs: number, callback: () => void): void;
}
export {};
