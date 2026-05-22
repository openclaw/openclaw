import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
export type HeartbeatSummary = {
    enabled: boolean;
    every: string;
    everyMs: number | null;
    prompt: string;
    target: string;
    model?: string;
    ackMaxChars: number;
};
export declare function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean;
export declare function resolveHeartbeatIntervalMs(cfg: OpenClawConfig, overrideEvery?: string, heartbeat?: HeartbeatConfig): number | null;
export declare function resolveHeartbeatSummaryForAgent(cfg: OpenClawConfig, agentId?: string): HeartbeatSummary;
export {};
