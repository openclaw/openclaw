import { monitorEventLoopDelay, performance } from "node:perf_hooks";
type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;
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
type EventLoopUtilizationReader = typeof performance.eventLoopUtilization;
type EventLoopDelayMonitorFactory = (resolutionMs: number) => EventLoopDelayMonitor;
type GatewayEventLoopHealthMonitorDeps = {
    now?: () => number;
    cpuUsage?: typeof process.cpuUsage;
    eventLoopUtilization?: EventLoopUtilizationReader;
    createDelayMonitor?: EventLoopDelayMonitorFactory;
};
type GatewayEventLoopHealthMetrics = Pick<GatewayEventLoopHealth, "intervalMs" | "delayP99Ms" | "delayMaxMs" | "utilization" | "cpuCoreRatio">;
export declare function classifyGatewayEventLoopHealthReasons(metrics: GatewayEventLoopHealthMetrics): GatewayEventLoopHealthReason[];
export declare function createGatewayEventLoopHealthMonitor(deps?: GatewayEventLoopHealthMonitorDeps): GatewayEventLoopHealthMonitor;
export {};
