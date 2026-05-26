import type { ChannelHeartbeatDeps } from "../channels/plugins/types.public.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type CommandLaneSnapshot } from "../process/command-queue.js";
import { type RuntimeEnv } from "../runtime.js";
import { isCronSystemEvent } from "./heartbeat-events-filter.js";
import { areHeartbeatsEnabled, type HeartbeatRunResult, type HeartbeatWakeIntent, type HeartbeatWakeSource, setHeartbeatsEnabled } from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
export type HeartbeatDeps = OutboundSendDeps & ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("./heartbeat-runner.runtime.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    getCommandLaneSnapshots?: () => readonly CommandLaneSnapshot[];
    nowMs?: () => number;
};
export { areHeartbeatsEnabled, setHeartbeatsEnabled };
export { isHeartbeatEnabledForAgent, resolveHeartbeatIntervalMs, resolveHeartbeatSummaryForAgent, type HeartbeatSummary, } from "./heartbeat-summary.js";
type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
export { isCronSystemEvent };
export type HeartbeatRunner = {
    stop: () => void;
    updateConfig: (cfg: OpenClawConfig) => void;
};
export declare function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig): string;
export declare function runHeartbeatOnce(opts: {
    cfg?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: HeartbeatConfig;
    source?: HeartbeatWakeSource;
    intent?: HeartbeatWakeIntent;
    reason?: string;
    deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult>;
export declare function startHeartbeatRunner(opts: {
    cfg?: OpenClawConfig;
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    runOnce?: typeof runHeartbeatOnce;
    stableSchedulerSeed?: string;
}): HeartbeatRunner;
