import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { type ContextEngineHostSupport } from "../../../context-engine/host-compat.js";
export type HostCandidate = {
    runtimeId: string;
    host: ContextEngineHostSupport;
    paths: string[];
};
/** Collect effective agent-run host candidates from config and environment runtime policy. */
export declare function collectConfiguredContextEngineAgentRunHosts(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): HostCandidate[];
/** Collect doctor warnings for context engines that cannot run under configured hosts. */
export declare function collectContextEngineHostCompatibilityWarnings(params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
/** Repair a globally incompatible context engine by falling back to legacy. */
export declare function maybeRepairContextEngineHostCompatibility(params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    config: OpenClawConfig;
    changes: string[];
    warnings?: string[];
}>;
