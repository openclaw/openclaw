import type { OpenClawConfig } from "../config/config.js";
export declare function collectSecurityWarnings(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): Promise<string[]>;
export declare function noteSecurityWarnings(cfg: OpenClawConfig): Promise<void>;
