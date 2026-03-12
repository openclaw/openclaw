import type { OpenClawConfig } from "../config/config.js";
export declare function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number;
export declare function resolveAgentTimeoutMs(opts: {
    cfg?: OpenClawConfig;
    overrideMs?: number | null;
    overrideSeconds?: number | null;
    minMs?: number;
}): number;
