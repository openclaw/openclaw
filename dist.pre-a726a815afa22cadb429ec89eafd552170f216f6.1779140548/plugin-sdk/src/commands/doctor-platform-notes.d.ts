import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findStaleOpenClawUpdateLaunchdJobs } from "../daemon/launchd.js";
import { note } from "../terminal/note.js";
export declare function collectMacLaunchAgentOverrideWarning(deps?: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    exists?: (candidate: string) => boolean;
}): string | null;
export declare function noteMacLaunchAgentOverrides(): Promise<void>;
export declare function collectMacStaleOpenClawUpdateLaunchdJobsWarning(deps?: {
    platform?: NodeJS.Platform;
    findJobs?: typeof findStaleOpenClawUpdateLaunchdJobs;
}): Promise<string | null>;
export declare function noteMacStaleOpenClawUpdateLaunchdJobs(deps?: {
    platform?: NodeJS.Platform;
    findJobs?: typeof findStaleOpenClawUpdateLaunchdJobs;
    noteFn?: typeof note;
}): Promise<void>;
export declare function collectMacLaunchctlGatewayEnvOverrideWarning(cfg: OpenClawConfig, deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
}): Promise<string | null>;
export declare function noteMacLaunchctlGatewayEnvOverrides(cfg: OpenClawConfig, deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
}): Promise<void>;
export declare function collectMacGatewayPlatformWarnings(cfg: OpenClawConfig): Promise<readonly string[]>;
export declare function noteStartupOptimizationHints(env?: NodeJS.ProcessEnv, deps?: {
    platform?: NodeJS.Platform;
    arch?: string;
    totalMemBytes?: number;
    noteFn?: typeof note;
}): void;
