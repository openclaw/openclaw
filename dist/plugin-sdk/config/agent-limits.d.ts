import type { OpenClawConfig } from "./types.js";
export declare const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export declare const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export declare const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
export declare function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number;
export declare function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number;
