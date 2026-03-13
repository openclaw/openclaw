import type { OpenClawConfig } from "../config/config.js";
import { type HeartbeatSummary } from "../infra/heartbeat-runner.js";
import type { RuntimeEnv } from "../runtime.js";
export type ChannelAccountHealthSummary = {
    accountId: string;
    configured?: boolean;
    linked?: boolean;
    authAgeMs?: number | null;
    probe?: unknown;
    lastProbeAt?: number | null;
    [key: string]: unknown;
};
export type ChannelHealthSummary = ChannelAccountHealthSummary & {
    accounts?: Record<string, ChannelAccountHealthSummary>;
};
export type AgentHeartbeatSummary = HeartbeatSummary;
export type AgentHealthSummary = {
    agentId: string;
    name?: string;
    isDefault: boolean;
    heartbeat: AgentHeartbeatSummary;
    sessions: HealthSummary["sessions"];
};
export type HealthSummary = {
    /**
     * Convenience top-level flag for UIs (e.g. WebChat) that only need a binary
     * "can talk to the gateway" signal. If this payload exists, the gateway RPC
     * succeeded, so this is always `true`.
     */
    ok: true;
    ts: number;
    durationMs: number;
    channels: Record<string, ChannelHealthSummary>;
    channelOrder: string[];
    channelLabels: Record<string, string>;
    /** Legacy: default agent heartbeat seconds (rounded). */
    heartbeatSeconds: number;
    defaultAgentId: string;
    agents: AgentHealthSummary[];
    sessions: {
        path: string;
        count: number;
        recent: Array<{
            key: string;
            updatedAt: number | null;
            age: number | null;
        }>;
    };
};
export declare const formatHealthChannelLines: (summary: HealthSummary, opts?: {
    accountMode?: "default" | "all";
    accountIdsByChannel?: Record<string, string[] | undefined>;
}) => string[];
export declare function getHealthSnapshot(params?: {
    timeoutMs?: number;
    probe?: boolean;
}): Promise<HealthSummary>;
export declare function healthCommand(opts: {
    json?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    config?: OpenClawConfig;
}, runtime: RuntimeEnv): Promise<void>;
