import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelRuntimeSnapshot } from "../gateway/server-channel-runtime.types.js";
import { type RuntimeEnv } from "../runtime.js";
import type { HealthSummary } from "./health.types.js";
export { formatHealthChannelLines } from "./health-format.js";
export type { AgentHealthSummary, ChannelAccountHealthSummary, ChannelHealthSummary, HealthSummary, } from "./health.types.js";
export declare function getHealthSnapshot(params?: {
    timeoutMs?: number;
    probe?: boolean;
    includeSensitive?: boolean;
    runtimeSnapshot?: ChannelRuntimeSnapshot;
}): Promise<HealthSummary>;
export declare function healthCommand(opts: {
    json?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    config?: OpenClawConfig;
    token?: string;
    password?: string;
}, runtime: RuntimeEnv): Promise<void>;
