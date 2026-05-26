import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
export declare function noteMacLaunchAgentOverrides(): Promise<void>;
export declare function noteMacLaunchctlGatewayEnvOverrides(cfg: OpenClawConfig, deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
}): Promise<void>;
export declare function noteStartupOptimizationHints(env?: NodeJS.ProcessEnv, deps?: {
    platform?: NodeJS.Platform;
    arch?: string;
    totalMemBytes?: number;
    noteFn?: typeof note;
}): void;
