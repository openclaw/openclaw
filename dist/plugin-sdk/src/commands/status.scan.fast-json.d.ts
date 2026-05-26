import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
type StatusJsonScanPolicy = {
    commandName: string;
    allowMissingConfigFastPath?: boolean;
    includeChannelSummary?: boolean;
    resolveHasConfiguredChannels: (cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => boolean;
    resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
};
export declare function scanStatusJsonWithPolicy(opts: {
    timeoutMs?: number;
    all?: boolean;
}, runtime: RuntimeEnv, policy: StatusJsonScanPolicy): Promise<StatusScanResult>;
export declare function scanStatusJsonFast(opts: {
    timeoutMs?: number;
    all?: boolean;
}, runtime: RuntimeEnv): Promise<StatusScanResult>;
export {};
