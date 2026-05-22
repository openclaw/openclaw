export type GatewayEventLoopHealthReason = "event_loop_delay" | "event_loop_utilization" | "cpu";
export type GatewayEventLoopHealth = {
    degraded: boolean;
    reasons: GatewayEventLoopHealthReason[];
    intervalMs: number;
    delayP99Ms: number;
    delayMaxMs: number;
    utilization: number;
    cpuCoreRatio: number;
};
export type GatewayEventLoopHealthMonitor = {
    snapshot: () => GatewayEventLoopHealth | undefined;
    stop: () => void;
};
export declare function createGatewayEventLoopHealthMonitor(): GatewayEventLoopHealthMonitor;
