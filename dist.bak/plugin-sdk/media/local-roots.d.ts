import type { OpenClawConfig } from "../config/config.js";
export declare function getDefaultMediaLocalRoots(): readonly string[];
export declare function getAgentScopedMediaLocalRoots(cfg: OpenClawConfig, agentId?: string): readonly string[];
